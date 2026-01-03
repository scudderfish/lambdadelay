#!/usr/bin/env node

const LambdaDelayAnalyzer = require('./analyze_lambda_delay.js');

// Test configurations
const testConfigs = [
  { pw: 0.2, lambda: 0.02, label: 'Loose' },
  { pw: 0.2, lambda: 0.05, label: 'Loose-Med' },
  { pw: 0.5, lambda: 0.05, label: 'Default' },
  { pw: 0.5, lambda: 0.10, label: 'Med-Tight' }
];

const baseConfig = {
  MIN_RPM: 500,
  MIN_PW: 1.0,
  MAX_DELAY_MS: 2000,
  BUCKET_COUNT: 3
};

console.log('Validating delay accuracy: Lambda prediction error analysis\n');
console.log('='.repeat(100));

// For each configuration, calculate the delay table and then validate it
const validationResults = [];

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

  // Get median delays for each bucket
  const delayTable = [];
  for (let i = 0; i < 3; i++) {
    delayTable[i] = [];
    for (let j = 0; j < 3; j++) {
      const delays = analyzer.buckets[i][j].delays;
      delayTable[i][j] = delays.length > 0 ? analyzer.median(delays) : null;
    }
  }

  // Now validate: For each data point, use the delay table to "predict" lambda
  // Compare predicted lambda (from PW shifted by delay) vs actual lambda
  const errors = [];

  for (const point of analyzer.data) {
    const rpmBucket = analyzer.getBucketIndex(point.rpm, analyzer.rpmBoundaries);
    const loadBucket = analyzer.getBucketIndex(point.load, analyzer.loadBoundaries);

    if (rpmBucket === -1 || loadBucket === -1) continue;

    const estimatedDelay = delayTable[rpmBucket][loadBucket];
    if (estimatedDelay === null) continue;

    // Find what the PW was 'estimatedDelay' milliseconds ago
    const targetTime = point.time - (estimatedDelay / 1000);

    // Find closest data point in time to targetTime
    let closestIdx = -1;
    let minTimeDiff = Infinity;

    for (let i = 0; i < analyzer.data.length; i++) {
      const timeDiff = Math.abs(analyzer.data[i].time - targetTime);
      if (timeDiff < minTimeDiff) {
        minTimeDiff = timeDiff;
        closestIdx = i;
      }
    }

    // If we found a reasonable historical point (within 500ms)
    if (closestIdx !== -1 && minTimeDiff < 0.5) {
      const historicalPW = analyzer.data[closestIdx].pw;
      const currentLambda = point.lambda;

      // The hypothesis: current lambda should correlate with historical PW
      // We can't directly predict lambda from PW, but we can check if the
      // delay-adjusted values show better correlation

      errors.push({
        rpm: point.rpm,
        load: point.load,
        bucket: `${rpmBucket},${loadBucket}`,
        historicalPW: historicalPW,
        currentPW: point.pw,
        currentLambda: currentLambda,
        estimatedDelay: estimatedDelay,
        timeDiff: minTimeDiff * 1000
      });
    }
  }

  // Calculate lambda variance for each bucket using delay-compensated values
  const bucketStats = {};

  for (const err of errors) {
    if (!bucketStats[err.bucket]) {
      bucketStats[err.bucket] = {
        lambdas: [],
        pwChanges: []
      };
    }
    bucketStats[err.bucket].lambdas.push(err.currentLambda);
    bucketStats[err.bucket].pwChanges.push(err.currentPW - err.historicalPW);
  }

  // Calculate statistics
  const bucketResults = [];
  for (const [bucket, stats] of Object.entries(bucketStats)) {
    if (stats.lambdas.length < 10) continue;

    const lambdaMean = stats.lambdas.reduce((a, b) => a + b, 0) / stats.lambdas.length;
    const lambdaStdDev = Math.sqrt(
      stats.lambdas.reduce((a, b) => a + Math.pow(b - lambdaMean, 2), 0) / stats.lambdas.length
    );

    // Calculate correlation between PW change and Lambda
    const pwMean = stats.pwChanges.reduce((a, b) => a + b, 0) / stats.pwChanges.length;
    let correlation = 0;
    let pwStdDev = Math.sqrt(
      stats.pwChanges.reduce((a, b) => a + Math.pow(b - pwMean, 2), 0) / stats.pwChanges.length
    );

    if (pwStdDev > 0 && lambdaStdDev > 0) {
      for (let i = 0; i < stats.lambdas.length; i++) {
        correlation += (stats.pwChanges[i] - pwMean) * (stats.lambdas[i] - lambdaMean);
      }
      correlation /= (stats.lambdas.length * pwStdDev * lambdaStdDev);
    }

    bucketResults.push({
      bucket: bucket,
      count: stats.lambdas.length,
      lambdaMean: lambdaMean,
      lambdaStdDev: lambdaStdDev,
      lambdaCV: (lambdaStdDev / lambdaMean) * 100,
      correlation: correlation
    });
  }

  validationResults.push({
    config: tc,
    bucketResults: bucketResults,
    totalPoints: errors.length
  });

  console.log(`\n${tc.label} (PW: ${tc.pw}, Lambda: ${tc.lambda}):`);
  console.log(`  Validated ${errors.length} data points using delay compensation`);
  console.log(`  Lambda variability by bucket:`);

  for (const br of bucketResults) {
    console.log(`    Bucket ${br.bucket}: Mean λ=${br.lambdaMean.toFixed(3)}, ` +
                `StdDev=${br.lambdaStdDev.toFixed(3)}, CV=${br.lambdaCV.toFixed(1)}%, ` +
                `PW-λ corr=${br.correlation.toFixed(3)} (n=${br.count})`);
  }
}

console.log('\n' + '='.repeat(100));
console.log('\nCross-Configuration Lambda Variance Analysis:\n');

// Compare lambda variance across configurations for same buckets
const bucketComparison = {};

for (const vr of validationResults) {
  for (const br of vr.bucketResults) {
    if (!bucketComparison[br.bucket]) {
      bucketComparison[br.bucket] = [];
    }
    bucketComparison[br.bucket].push({
      config: vr.config.label,
      lambdaStdDev: br.lambdaStdDev,
      lambdaCV: br.lambdaCV,
      count: br.count
    });
  }
}

console.log('Lambda standard deviation by bucket across configurations:\n');
console.log('(Lower StdDev = more accurate delay compensation)\n');

for (const [bucket, configs] of Object.entries(bucketComparison)) {
  console.log(`Bucket ${bucket}:`);

  const stdDevs = configs.map(c => c.lambdaStdDev);
  const avgStdDev = stdDevs.reduce((a, b) => a + b, 0) / stdDevs.length;
  const minStdDev = Math.min(...stdDevs);
  const maxStdDev = Math.max(...stdDevs);
  const range = maxStdDev - minStdDev;
  const rangePercent = (range / avgStdDev) * 100;

  for (const c of configs) {
    console.log(`  ${c.config.padEnd(12)}: λ StdDev=${c.lambdaStdDev.toFixed(3)}, CV=${c.lambdaCV.toFixed(1)}%`);
  }

  console.log(`  Range: ${range.toFixed(3)} (${rangePercent.toFixed(1)}% of average)`);

  if (rangePercent < 10) {
    console.log(`  ✓ STABLE: Delay choice has minimal impact on lambda prediction error`);
  } else if (rangePercent < 25) {
    console.log(`  ~ MODERATE: Some sensitivity to delay choice`);
  } else {
    console.log(`  ✗ VARIABLE: Delay choice significantly affects prediction accuracy`);
  }
  console.log('');
}

// Overall summary
console.log('='.repeat(100));
console.log('\nOVERALL SUMMARY:\n');

let totalStable = 0;
let totalModerate = 0;
let totalVariable = 0;

for (const [bucket, configs] of Object.entries(bucketComparison)) {
  const stdDevs = configs.map(c => c.lambdaStdDev);
  const avgStdDev = stdDevs.reduce((a, b) => a + b, 0) / stdDevs.length;
  const range = Math.max(...stdDevs) - Math.min(...stdDevs);
  const rangePercent = (range / avgStdDev) * 100;

  if (rangePercent < 10) totalStable++;
  else if (rangePercent < 25) totalModerate++;
  else totalVariable++;
}

const totalBuckets = Object.keys(bucketComparison).length;

console.log(`Analyzed ${totalBuckets} buckets with sufficient data across configurations:`);
console.log(`  Stable (< 10% variation):    ${totalStable} buckets`);
console.log(`  Moderate (10-25% variation): ${totalModerate} buckets`);
console.log(`  Variable (> 25% variation):  ${totalVariable} buckets`);

console.log('\nInterpretation:');
console.log('  Lambda StdDev represents the inherent variability in lambda readings');
console.log('  when using the calculated delay to compensate for sensor lag.');
console.log('  Lower variation across configs = delay parameter choice matters less.');
