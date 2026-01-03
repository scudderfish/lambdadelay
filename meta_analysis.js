#!/usr/bin/env node

const LambdaDelayAnalyzer = require('./analyze_lambda_delay.js');
const fs = require('fs');
const path = require('path');

// Use recommended thresholds for best coverage
const config = {
  MIN_RPM: 500,
  MIN_PW: 1.0,
  PW_CHANGE_THRESHOLD: 0.2,
  LAMBDA_CHANGE_THRESHOLD: 0.02,
  MAX_DELAY_MS: 2000,
  BUCKET_COUNT: 3
};

console.log('Meta-Analysis: Analyzing all log files from the same car\n');
console.log('='.repeat(100));

// Find all .msl files
const logFiles = fs.readdirSync('example')
  .filter(f => f.endsWith('.msl'))
  .map(f => path.join('example', f))
  .sort();

console.log(`Found ${logFiles.length} log files\n`);

// Analyze each file
const allResults = [];

for (const logFile of logFiles) {
  const basename = path.basename(logFile);

  try {
    const analyzer = new LambdaDelayAnalyzer(logFile, config);

    // Suppress output
    const originalLog = console.log;
    console.log = () => {};

    analyzer.parseFile();
    analyzer.calculateBucketBoundaries();
    analyzer.assignToBuckets();
    analyzer.calculateDelays();

    console.log = originalLog;

    // Extract delay table
    const delayTable = [];
    let totalMeasurements = 0;
    let bucketsWithData = 0;

    for (let i = 0; i < 3; i++) {
      delayTable[i] = [];
      for (let j = 0; j < 3; j++) {
        const delays = analyzer.buckets[i][j].delays;
        const median = delays.length > 0 ? analyzer.median(delays) : null;
        delayTable[i][j] = {
          median: median !== null ? Math.round(median * 10) / 10 : null,
          count: delays.length
        };
        totalMeasurements += delays.length;
        if (delays.length > 0) bucketsWithData++;
      }
    }

    allResults.push({
      file: basename,
      dataPoints: analyzer.data.length,
      totalMeasurements: totalMeasurements,
      bucketsWithData: bucketsWithData,
      rpmBoundaries: analyzer.rpmBoundaries,
      loadBoundaries: analyzer.loadBoundaries,
      delayTable: delayTable
    });

    console.log(`✓ ${basename.padEnd(30)} ${analyzer.data.length.toString().padStart(6)} points, ` +
                `${totalMeasurements.toString().padStart(4)} measurements, ${bucketsWithData}/9 buckets`);

  } catch (error) {
    console.log(`✗ ${basename.padEnd(30)} ERROR: ${error.message}`);
  }
}

console.log('\n' + '='.repeat(100));
console.log('\nCross-File Delay Value Analysis\n');

// For each bucket, collect all delay values across files
const bucketStats = {};

for (let i = 0; i < 3; i++) {
  for (let j = 0; j < 3; j++) {
    const bucketKey = `[${i},${j}]`;
    const values = [];

    for (const result of allResults) {
      const median = result.delayTable[i][j].median;
      if (median !== null) {
        values.push(median);
      }
    }

    if (values.length > 1) {
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
      const stdDev = Math.sqrt(variance);
      const cv = (stdDev / mean) * 100;
      const min = Math.min(...values);
      const max = Math.max(...values);
      const range = max - min;

      bucketStats[bucketKey] = {
        rpm: i,
        load: j,
        filesWithData: values.length,
        values: values,
        mean: mean,
        stdDev: stdDev,
        cv: cv,
        min: min,
        max: max,
        range: range
      };
    }
  }
}

// Display bucket statistics
console.log('Delay Value Consistency Across Log Files:\n');
console.log('Bucket      Files  Mean(ms)  StdDev   CV%    Min     Max     Range   Assessment');
console.log('-'.repeat(100));

const sortedBuckets = Object.entries(bucketStats).sort((a, b) => a[1].cv - b[1].cv);

for (const [bucket, stats] of sortedBuckets) {
  let assessment;
  if (stats.cv < 15) assessment = 'EXCELLENT';
  else if (stats.cv < 25) assessment = 'GOOD';
  else if (stats.cv < 40) assessment = 'MODERATE';
  else assessment = 'VARIABLE';

  console.log(`${bucket.padEnd(11)} ${stats.filesWithData.toString().padStart(5)}  ` +
              `${stats.mean.toFixed(1).padStart(7)}  ` +
              `${stats.stdDev.toFixed(1).padStart(6)}  ` +
              `${stats.cv.toFixed(1).padStart(5)}  ` +
              `${stats.min.toFixed(1).padStart(6)}  ` +
              `${stats.max.toFixed(1).padStart(6)}  ` +
              `${stats.range.toFixed(1).padStart(6)}  ${assessment}`);
}

const avgCV = Object.values(bucketStats).reduce((a, b) => a + b.cv, 0) / Object.keys(bucketStats).length;
console.log('\n' + '-'.repeat(100));
console.log(`Average CV across all buckets: ${avgCV.toFixed(1)}%`);

if (avgCV < 20) {
  console.log('=> HIGHLY CONSISTENT: Delay values are very stable across different log files');
} else if (avgCV < 35) {
  console.log('=> MODERATELY CONSISTENT: Some variation but generally predictable');
} else {
  console.log('=> VARIABLE: Significant variation across log files');
}

// Calculate a "master" delay table from all files
console.log('\n' + '='.repeat(100));
console.log('\nMaster Delay Table (Aggregate from all files):\n');

const masterTable = [];
for (let i = 0; i < 3; i++) {
  masterTable[i] = [];
  for (let j = 0; j < 3; j++) {
    const bucketKey = `[${i},${j}]`;
    if (bucketStats[bucketKey]) {
      masterTable[i][j] = Math.round(bucketStats[bucketKey].mean * 10) / 10;
    } else {
      masterTable[i][j] = null;
    }
  }
}

// Display master table
console.log('RPM\\Load    Low         Medium      High');
console.log('-'.repeat(50));
const rpmLabels = ['Low', 'Medium', 'High'];
for (let i = 0; i < 3; i++) {
  let line = rpmLabels[i].padEnd(11);
  for (let j = 0; j < 3; j++) {
    if (masterTable[i][j] !== null) {
      line += `${masterTable[i][j].toFixed(1)}ms`.padEnd(12);
    } else {
      line += 'N/A'.padEnd(12);
    }
  }
  console.log(line);
}

// Cross-validation: test each file against the master table
console.log('\n' + '='.repeat(100));
console.log('\nCross-Validation: Testing master table prediction accuracy\n');

const crossValResults = [];

for (const result of allResults) {
  const logFile = result.file;

  // For this file, calculate lambda prediction error using master table vs own table
  const analyzer = new LambdaDelayAnalyzer(path.join('example', logFile), config);

  const originalLog = console.log;
  console.log = () => {};

  analyzer.parseFile();
  analyzer.calculateBucketBoundaries();
  analyzer.assignToBuckets();

  console.log = originalLog;

  // Test with master table
  const masterErrors = calculateLambdaErrors(analyzer, masterTable);

  // Test with own table
  const ownDelayTable = [];
  for (let i = 0; i < 3; i++) {
    ownDelayTable[i] = [];
    for (let j = 0; j < 3; j++) {
      ownDelayTable[i][j] = result.delayTable[i][j].median;
    }
  }
  const ownErrors = calculateLambdaErrors(analyzer, ownDelayTable);

  crossValResults.push({
    file: logFile,
    masterError: masterErrors,
    ownError: ownErrors
  });
}

// Display cross-validation results
console.log('File                           Master Table λ StdDev  Own Table λ StdDev  Difference');
console.log('-'.repeat(100));

for (const cv of crossValResults) {
  const masterAvg = cv.masterError.avgStdDev;
  const ownAvg = cv.ownError.avgStdDev;
  const diff = masterAvg - ownAvg;
  const diffPct = (diff / ownAvg) * 100;

  let status = '';
  if (Math.abs(diffPct) < 5) status = '✓ EXCELLENT';
  else if (Math.abs(diffPct) < 10) status = '✓ GOOD';
  else if (Math.abs(diffPct) < 20) status = '~ MODERATE';
  else status = '✗ POOR';

  console.log(`${cv.file.padEnd(30)} ${masterAvg.toFixed(4).padStart(10)}          ` +
              `${ownAvg.toFixed(4).padStart(10)}          ` +
              `${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(1)}% ${status}`);
}

// Overall summary
const avgMasterError = crossValResults.reduce((a, b) => a + b.masterError.avgStdDev, 0) / crossValResults.length;
const avgOwnError = crossValResults.reduce((a, b) => a + b.ownError.avgStdDev, 0) / crossValResults.length;
const avgDiff = ((avgMasterError - avgOwnError) / avgOwnError) * 100;

console.log('\n' + '-'.repeat(100));
console.log('\nOVERALL CROSS-VALIDATION SUMMARY:');
console.log(`  Average λ StdDev with Master Table: ${avgMasterError.toFixed(4)}`);
console.log(`  Average λ StdDev with Own Table:    ${avgOwnError.toFixed(4)}`);
console.log(`  Average Difference:                 ${avgDiff >= 0 ? '+' : ''}${avgDiff.toFixed(1)}%`);

if (Math.abs(avgDiff) < 5) {
  console.log('\n✓✓✓ EXCELLENT: Master table performs as well as file-specific tables!');
  console.log('    The car has consistent lambda delay characteristics across all sessions.');
} else if (Math.abs(avgDiff) < 10) {
  console.log('\n✓✓ GOOD: Master table performs nearly as well as file-specific tables.');
  console.log('   Minor variations exist but the master table is highly reliable.');
} else if (Math.abs(avgDiff) < 20) {
  console.log('\n✓ ACCEPTABLE: Master table provides reasonable predictions.');
  console.log('  Some variation exists - consider environmental factors.');
} else {
  console.log('\n✗ VARIABLE: Significant differences between sessions.');
  console.log('  Consider analyzing what changed between sessions (temp, altitude, sensor aging, etc.)');
}

// Helper function to calculate lambda errors
function calculateLambdaErrors(analyzer, delayTable) {
  const bucketErrors = {};

  for (const point of analyzer.data) {
    const rpmBucket = analyzer.getBucketIndex(point.rpm, analyzer.rpmBoundaries);
    const loadBucket = analyzer.getBucketIndex(point.load, analyzer.loadBoundaries);

    if (rpmBucket === -1 || loadBucket === -1) continue;

    const estimatedDelay = delayTable[rpmBucket][loadBucket];
    if (estimatedDelay === null) continue;

    const targetTime = point.time - (estimatedDelay / 1000);

    // Find closest historical point
    let closestIdx = -1;
    let minTimeDiff = Infinity;

    for (let i = 0; i < analyzer.data.length; i++) {
      const timeDiff = Math.abs(analyzer.data[i].time - targetTime);
      if (timeDiff < minTimeDiff) {
        minTimeDiff = timeDiff;
        closestIdx = i;
      }
    }

    if (closestIdx !== -1 && minTimeDiff < 0.5) {
      const bucketKey = `${rpmBucket},${loadBucket}`;
      if (!bucketErrors[bucketKey]) {
        bucketErrors[bucketKey] = [];
      }
      bucketErrors[bucketKey].push(point.lambda);
    }
  }

  // Calculate statistics
  const stdDevs = [];
  for (const lambdas of Object.values(bucketErrors)) {
    if (lambdas.length < 10) continue;
    const mean = lambdas.reduce((a, b) => a + b, 0) / lambdas.length;
    const stdDev = Math.sqrt(lambdas.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / lambdas.length);
    stdDevs.push(stdDev);
  }

  const avgStdDev = stdDevs.length > 0 ? stdDevs.reduce((a, b) => a + b, 0) / stdDevs.length : 0;

  return {
    bucketErrors: bucketErrors,
    avgStdDev: avgStdDev,
    bucketsAnalyzed: stdDevs.length
  };
}

console.log('\n' + '='.repeat(100));
console.log('\nMeta-analysis complete!');
console.log('\nKey Findings:');
console.log(`  - Analyzed ${allResults.length} log files from the same car`);
console.log(`  - Average delay value consistency: CV = ${avgCV.toFixed(1)}%`);
console.log(`  - Master table prediction accuracy: ${avgDiff >= 0 ? '+' : ''}${avgDiff.toFixed(1)}% vs file-specific tables`);
