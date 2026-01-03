#!/usr/bin/env node

const { Worker } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Use recommended thresholds for best coverage
const config = {
  MIN_RPM: 500,
  MIN_PW: 1.0,
  PW_CHANGE_THRESHOLD: 0.2,
  LAMBDA_CHANGE_THRESHOLD: 0.02,
  MAX_DELAY_MS: 2000,
  BUCKET_COUNT: 3
};

console.log('Meta-Analysis (Parallel): Analyzing all log files from the same car\n');
console.log('='.repeat(100));

// Find all .msl files
const logFiles = fs.readdirSync('example')
  .filter(f => f.endsWith('.msl'))
  .map(f => path.join('example', f))
  .sort();

const numCPUs = os.cpus().length;
console.log(`Found ${logFiles.length} log files`);
console.log(`Using ${numCPUs} CPU cores for parallel processing\n`);

// Worker code as a string (to avoid separate file)
const workerCode = `
const { parentPort, workerData } = require('worker_threads');
const LambdaDelayAnalyzer = require('./analyze_lambda_delay.js');

const { logFile, config } = workerData;

try {
  const analyzer = new LambdaDelayAnalyzer(logFile, config);

  // Suppress console output
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

  // Send results back
  parentPort.postMessage({
    success: true,
    file: logFile,
    dataPoints: analyzer.data.length,
    totalMeasurements: totalMeasurements,
    bucketsWithData: bucketsWithData,
    rpmBoundaries: analyzer.rpmBoundaries,
    loadBoundaries: analyzer.loadBoundaries,
    delayTable: delayTable,
    data: analyzer.data // Need this for cross-validation
  });

} catch (error) {
  parentPort.postMessage({
    success: false,
    file: logFile,
    error: error.message
  });
}
`;

// Write worker code to temporary file
const workerFile = path.join(__dirname, '.worker_temp.js');
fs.writeFileSync(workerFile, workerCode);

// Process files in parallel
async function processFilesInParallel() {
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const results = [];
    let completed = 0;
    let activeWorkers = 0;
    let fileIndex = 0;

    function startWorker() {
      if (fileIndex >= logFiles.length) return;

      const logFile = logFiles[fileIndex++];
      activeWorkers++;

      const worker = new Worker(workerFile, {
        workerData: { logFile, config }
      });

      worker.on('message', (result) => {
        activeWorkers--;
        completed++;

        const basename = path.basename(result.file);
        if (result.success) {
          results.push(result);
          console.log(`✓ [${completed}/${logFiles.length}] ${basename.padEnd(30)} ` +
                      `${result.dataPoints.toString().padStart(6)} points, ` +
                      `${result.totalMeasurements.toString().padStart(4)} measurements, ` +
                      `${result.bucketsWithData}/9 buckets`);
        } else {
          console.log(`✗ [${completed}/${logFiles.length}] ${basename.padEnd(30)} ERROR: ${result.error}`);
        }

        // Start next worker or finish
        if (completed === logFiles.length) {
          const duration = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`\nCompleted in ${duration}s`);
          resolve(results);
        } else {
          startWorker();
        }
      });

      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Worker stopped with exit code ${code}`));
        }
      });
    }

    // Start initial batch of workers
    const initialWorkers = Math.min(numCPUs, logFiles.length);
    for (let i = 0; i < initialWorkers; i++) {
      startWorker();
    }
  });
}

// Main execution
processFilesInParallel()
  .then(allResults => {
    // Clean up worker file
    fs.unlinkSync(workerFile);

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

    // Calculate average RPM and Load axis values across all files
    const rpmAxisValues = [[], [], []];
    const loadAxisValues = [[], [], []];

    for (const result of allResults) {
      if (result.rpmBoundaries && result.loadBoundaries) {
        for (let i = 0; i < 3; i++) {
          const rpmMid = (result.rpmBoundaries[i] + result.rpmBoundaries[i + 1]) / 2;
          const loadMid = (result.loadBoundaries[i] + result.loadBoundaries[i + 1]) / 2;
          rpmAxisValues[i].push(rpmMid);
          loadAxisValues[i].push(loadMid);
        }
      }
    }

    const rpmAxis = [];
    const loadAxis = [];
    for (let i = 0; i < 3; i++) {
      const avgRpm = rpmAxisValues[i].reduce((a, b) => a + b, 0) / rpmAxisValues[i].length;
      const avgLoad = loadAxisValues[i].reduce((a, b) => a + b, 0) / loadAxisValues[i].length;
      rpmAxis.push(Math.round(avgRpm));
      loadAxis.push(Math.round(avgLoad));
    }

    // Display master table (human readable)
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

    // Display code-ready format
    console.log('\n' + '='.repeat(100));
    console.log('\nCode Format (ready to use):\n');

    console.log('const defaultLambdaDelayTable = [');
    for (let i = 0; i < 3; i++) {
      const row = [];
      for (let j = 0; j < 3; j++) {
        row.push(masterTable[i][j] !== null ? Math.round(masterTable[i][j]) : 0);
      }
      const rowStr = '    [' + row.join(', ') + ']';
      console.log(rowStr + (i < 2 ? ',' : ''));
    }
    console.log('];');
    console.log('');
    console.log(`const defaultLDRPM = [${rpmAxis.join(', ')}];`);
    console.log(`const defaultLDLoad = [${loadAxis.join(', ')}];`);

    // Cross-validation
    console.log('\n' + '='.repeat(100));
    console.log('\nCross-Validation: Testing master table prediction accuracy');
    console.log('(Processing in parallel...)\n');

    return crossValidateParallel(allResults, masterTable);
  })
  .then(crossValResults => {
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

    // Get avgCV from earlier calculation
    return { crossValResults, avgMasterError, avgOwnError, avgDiff };
  })
  .then(({ crossValResults, avgMasterError, avgOwnError, avgDiff }) => {
    // Calculate avgCV from bucketStats (need to recalculate in this scope)
    const logFiles = fs.readdirSync('example')
      .filter(f => f.endsWith('.msl'))
      .map(f => path.join('example', f));

    console.log('\n' + '='.repeat(100));
    console.log('\nMeta-analysis complete!');
    console.log('\nKey Findings:');
    console.log(`  - Analyzed ${crossValResults.length} log files from the same car`);
    console.log(`  - Master table prediction accuracy: ${avgDiff >= 0 ? '+' : ''}${avgDiff.toFixed(1)}% vs file-specific tables`);
  })
  .catch(error => {
    console.error('Error during analysis:', error);
    if (fs.existsSync(workerFile)) {
      fs.unlinkSync(workerFile);
    }
    process.exit(1);
  });

// Cross-validation in parallel
async function crossValidateParallel(allResults, masterTable) {
  const crossValWorkerCode = `
const { parentPort, workerData } = require('worker_threads');
const LambdaDelayAnalyzer = require('./analyze_lambda_delay.js');

const { result, masterTable, config } = workerData;

const analyzer = new LambdaDelayAnalyzer(result.file, config);

const originalLog = console.log;
console.log = () => {};

analyzer.parseFile();
analyzer.calculateBucketBoundaries();
analyzer.assignToBuckets();

console.log = originalLog;

// Calculate errors for both tables
const masterErrors = calculateLambdaErrors(analyzer, masterTable);

const ownDelayTable = [];
for (let i = 0; i < 3; i++) {
  ownDelayTable[i] = [];
  for (let j = 0; j < 3; j++) {
    ownDelayTable[i][j] = result.delayTable[i][j].median;
  }
}
const ownErrors = calculateLambdaErrors(analyzer, ownDelayTable);

parentPort.postMessage({
  file: result.file,
  masterError: masterErrors,
  ownError: ownErrors
});

function calculateLambdaErrors(analyzer, delayTable) {
  const bucketErrors = {};

  // Sort data by time once (data is already sorted from parseFile)
  // Build a time index for fast lookups using binary search
  const times = analyzer.data.map(d => d.time);

  // Binary search helper
  function findClosestIndex(targetTime) {
    let left = 0;
    let right = times.length - 1;
    let closest = 0;
    let minDiff = Infinity;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const diff = Math.abs(times[mid] - targetTime);

      if (diff < minDiff) {
        minDiff = diff;
        closest = mid;
      }

      if (times[mid] < targetTime) {
        left = mid + 1;
      } else if (times[mid] > targetTime) {
        right = mid - 1;
      } else {
        return mid;
      }
    }

    return minDiff < 0.5 ? closest : -1;
  }

  // Process all data points
  for (let idx = 0; idx < analyzer.data.length; idx++) {
    const point = analyzer.data[idx];
    const rpmBucket = analyzer.getBucketIndex(point.rpm, analyzer.rpmBoundaries);
    const loadBucket = analyzer.getBucketIndex(point.load, analyzer.loadBoundaries);

    if (rpmBucket === -1 || loadBucket === -1) continue;

    const estimatedDelay = delayTable[rpmBucket][loadBucket];
    if (estimatedDelay === null) continue;

    const targetTime = point.time - (estimatedDelay / 1000);
    const closestIdx = findClosestIndex(targetTime);

    if (closestIdx !== -1) {
      const bucketKey = \`\${rpmBucket},\${loadBucket}\`;
      if (!bucketErrors[bucketKey]) {
        bucketErrors[bucketKey] = [];
      }
      bucketErrors[bucketKey].push(point.lambda);
    }
  }

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
`;

  const crossValWorkerFile = path.join(__dirname, '.crossval_worker_temp.js');
  fs.writeFileSync(crossValWorkerFile, crossValWorkerCode);

  return new Promise((resolve, reject) => {
    const results = [];
    let completed = 0;
    let fileIndex = 0;

    function startWorker() {
      if (fileIndex >= allResults.length) return;

      const result = allResults[fileIndex++];

      const worker = new Worker(crossValWorkerFile, {
        workerData: { result, masterTable, config }
      });

      worker.on('message', (cvResult) => {
        completed++;
        results.push({
          file: path.basename(cvResult.file),
          masterError: cvResult.masterError,
          ownError: cvResult.ownError
        });

        if (completed === allResults.length) {
          fs.unlinkSync(crossValWorkerFile);
          resolve(results);
        } else {
          startWorker();
        }
      });

      worker.on('error', reject);
    }

    const initialWorkers = Math.min(os.cpus().length, allResults.length);
    for (let i = 0; i < initialWorkers; i++) {
      startWorker();
    }
  });
}
