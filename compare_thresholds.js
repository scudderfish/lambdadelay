#!/usr/bin/env node

const LambdaDelayAnalyzer = require('./analyze_lambda_delay.js');

// Compare specific threshold configurations
const testConfigs = [
  { pw: 0.2, lambda: 0.02 },
  { pw: 0.2, lambda: 0.05 },
  { pw: 0.2, lambda: 0.10 },
  { pw: 0.5, lambda: 0.02 },
  { pw: 0.5, lambda: 0.05 },  // current default
  { pw: 0.5, lambda: 0.10 },
  { pw: 1.0, lambda: 0.05 },
  { pw: 1.0, lambda: 0.10 }
];

const baseConfig = {
  MIN_RPM: 500,
  MIN_PW: 1.0,
  MAX_DELAY_MS: 2000,
  BUCKET_COUNT: 3
};

console.log('Comparing median delay values across different thresholds...\n');
console.log('='.repeat(100));

// Collect results for each configuration
const allResults = [];

for (const tc of testConfigs) {
  const testConfig = {
    ...baseConfig,
    PW_CHANGE_THRESHOLD: tc.pw,
    LAMBDA_CHANGE_THRESHOLD: tc.lambda
  };

  const analyzer = new LambdaDelayAnalyzer('example/2025-07-09_11-35-15.msl', testConfig);

  // Suppress output
  const originalLog = console.log;
  console.log = () => {};

  analyzer.parseFile();
  analyzer.calculateBucketBoundaries();
  analyzer.assignToBuckets();
  analyzer.calculateDelays();

  console.log = originalLog;

  // Collect median delays for each bucket
  const bucketMedians = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const delays = analyzer.buckets[i][j].delays;
      const median = delays.length > 0 ? analyzer.median(delays) : null;
      bucketMedians.push({
        rpm: i,
        load: j,
        count: delays.length,
        median: median !== null ? Math.round(median * 10) / 10 : null
      });
    }
  }

  allResults.push({
    pw: tc.pw,
    lambda: tc.lambda,
    buckets: bucketMedians
  });
}

// Display comparison table
console.log('\nMedian Delay Values (ms) by Bucket:\n');

const bucketLabels = [
  'RPM[0] Load[0]', 'RPM[0] Load[1]', 'RPM[0] Load[2]',
  'RPM[1] Load[0]', 'RPM[1] Load[1]', 'RPM[1] Load[2]',
  'RPM[2] Load[0]', 'RPM[2] Load[1]', 'RPM[2] Load[2]'
];

// Header
let header = 'Bucket         ';
for (const tc of testConfigs) {
  header += `PW:${tc.pw.toFixed(1)} L:${tc.lambda.toFixed(2)}`.padEnd(15);
}
console.log(header);
console.log('-'.repeat(header.length));

// Each bucket row
for (let bucketIdx = 0; bucketIdx < 9; bucketIdx++) {
  let row = bucketLabels[bucketIdx].padEnd(15);
  const valuesInRow = [];

  for (const result of allResults) {
    const bucket = result.buckets[bucketIdx];
    if (bucket.median !== null) {
      row += `${bucket.median.toFixed(1).padStart(6)} (${bucket.count.toString().padStart(3)})`.padEnd(15);
      valuesInRow.push(bucket.median);
    } else {
      row += 'N/A'.padEnd(15);
    }
  }

  console.log(row);

  // Calculate statistics for this bucket across configurations
  if (valuesInRow.length > 1) {
    const mean = valuesInRow.reduce((a, b) => a + b, 0) / valuesInRow.length;
    const variance = valuesInRow.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / valuesInRow.length;
    const stdDev = Math.sqrt(variance);
    const coeffVar = (stdDev / mean) * 100; // Coefficient of variation (%)
    const min = Math.min(...valuesInRow);
    const max = Math.max(...valuesInRow);
    const range = max - min;

    console.log(`${''.padEnd(15)}Stats: Mean=${mean.toFixed(1)}ms, StdDev=${stdDev.toFixed(1)}ms, CV=${coeffVar.toFixed(1)}%, Range=${range.toFixed(1)}ms`);
  }
  console.log('');
}

console.log('='.repeat(100));
console.log('\nLegend: Value (count) = median delay in ms (number of measurements)');
console.log('Stats: CV = Coefficient of Variation (lower = more consistent across thresholds)');

// Overall consistency analysis
console.log('\n\nConsistency Summary:\n');

const bucketStats = [];
for (let bucketIdx = 0; bucketIdx < 9; bucketIdx++) {
  const valuesInBucket = [];
  for (const result of allResults) {
    const median = result.buckets[bucketIdx].median;
    if (median !== null) valuesInBucket.push(median);
  }

  if (valuesInBucket.length > 1) {
    const mean = valuesInBucket.reduce((a, b) => a + b, 0) / valuesInBucket.length;
    const stdDev = Math.sqrt(valuesInBucket.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / valuesInBucket.length);
    const coeffVar = (stdDev / mean) * 100;

    bucketStats.push({
      bucket: bucketLabels[bucketIdx],
      configs: valuesInBucket.length,
      mean: mean,
      stdDev: stdDev,
      cv: coeffVar
    });
  }
}

bucketStats.sort((a, b) => a.cv - b.cv);

console.log('Buckets ordered by consistency (low CV = more consistent):');
for (let i = 0; i < bucketStats.length; i++) {
  const s = bucketStats[i];
  console.log(`  ${(i+1).toString().padStart(2)}. ${s.bucket.padEnd(15)} ` +
              `Mean: ${s.mean.toFixed(1).padStart(6)}ms, ` +
              `StdDev: ${s.stdDev.toFixed(1).padStart(6)}ms, ` +
              `CV: ${s.cv.toFixed(1).padStart(5)}% ` +
              `(${s.configs} configs with data)`);
}

const avgCV = bucketStats.reduce((a, b) => a + b.cv, 0) / bucketStats.length;
console.log(`\nAverage Coefficient of Variation across all buckets: ${avgCV.toFixed(1)}%`);

if (avgCV < 20) {
  console.log('=> HIGHLY CONSISTENT: Values are stable across threshold changes');
} else if (avgCV < 40) {
  console.log('=> MODERATELY CONSISTENT: Some variation but generally stable');
} else {
  console.log('=> VARIABLE: Values change significantly with threshold changes');
}
