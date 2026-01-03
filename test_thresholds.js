#!/usr/bin/env node

const LambdaDelayAnalyzer = require('./analyze_lambda_delay.js');

// Test different threshold combinations
const pwThresholds = [0.2, 0.5, 1.0, 1.5, 2.0];
const lambdaThresholds = [0.02, 0.05, 0.1, 0.15, 0.2];

const baseConfig = {
  MIN_RPM: 500,
  MIN_PW: 1.0,
  PW_CHANGE_THRESHOLD: 0.5,
  LAMBDA_CHANGE_THRESHOLD: 0.05,
  MAX_DELAY_MS: 2000,
  BUCKET_COUNT: 3
};

console.log('Testing sensitivity to threshold parameters...\n');
console.log('='.repeat(80));

const results = [];

for (const pwThreshold of pwThresholds) {
  for (const lambdaThreshold of lambdaThresholds) {
    // Create config with modified thresholds
    const testConfig = {
      ...baseConfig,
      PW_CHANGE_THRESHOLD: pwThreshold,
      LAMBDA_CHANGE_THRESHOLD: lambdaThreshold
    };

    const analyzer = new LambdaDelayAnalyzer('example/2025-07-09_11-35-15.msl', testConfig);

    // Suppress normal output
    const originalLog = console.log;
    console.log = () => {};

    try {
      analyzer.parseFile();
      analyzer.calculateBucketBoundaries();
      analyzer.assignToBuckets();
      analyzer.calculateDelays();

      // Re-enable logging
      console.log = originalLog;

      // Count total delay measurements and collect delays per bucket
      let totalMeasurements = 0;
      let bucketsWithData = 0;
      const bucketDetails = [];

      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          const delays = analyzer.buckets[i][j].delays;
          totalMeasurements += delays.length;
          if (delays.length > 0) {
            bucketsWithData++;
            const median = analyzer.median(delays);
            bucketDetails.push({
              rpm: i,
              load: j,
              count: delays.length,
              median: Math.round(median * 10) / 10
            });
          }
        }
      }

      results.push({
        pwThreshold,
        lambdaThreshold,
        totalMeasurements,
        bucketsWithData,
        bucketDetails
      });

      console.log(`PW: ${pwThreshold.toFixed(2)}, Lambda: ${lambdaThreshold.toFixed(3)} => ` +
                  `${totalMeasurements.toString().padStart(3)} measurements, ` +
                  `${bucketsWithData}/9 buckets`);

    } catch (error) {
      console.log = originalLog;
      console.log(`Error with PW: ${pwThreshold}, Lambda: ${lambdaThreshold}: ${error.message}`);
    }
  }
}

console.log('\n' + '='.repeat(80));
console.log('\nSummary Analysis:\n');

// Find configurations with best coverage
const withFullCoverage = results.filter(r => r.bucketsWithData >= 6);
const sortedByMeasurements = [...results].sort((a, b) => b.totalMeasurements - a.totalMeasurements);
const sortedByCoverage = [...results].sort((a, b) => {
  if (b.bucketsWithData !== a.bucketsWithData) {
    return b.bucketsWithData - a.bucketsWithData;
  }
  return b.totalMeasurements - a.totalMeasurements;
});

console.log('Top 5 by bucket coverage:');
for (let i = 0; i < Math.min(5, sortedByCoverage.length); i++) {
  const r = sortedByCoverage[i];
  console.log(`  ${i+1}. PW: ${r.pwThreshold.toFixed(2)}, Lambda: ${r.lambdaThreshold.toFixed(3)} => ` +
              `${r.totalMeasurements} measurements, ${r.bucketsWithData}/9 buckets`);
}

console.log('\nTop 5 by total measurements:');
for (let i = 0; i < Math.min(5, sortedByMeasurements.length); i++) {
  const r = sortedByMeasurements[i];
  console.log(`  ${i+1}. PW: ${r.pwThreshold.toFixed(2)}, Lambda: ${r.lambdaThreshold.toFixed(3)} => ` +
              `${r.totalMeasurements} measurements, ${r.bucketsWithData}/9 buckets`);
}

// Show current default
const defaultResult = results.find(r => r.pwThreshold === 0.5 && r.lambdaThreshold === 0.05);
if (defaultResult) {
  console.log('\nCurrent default (PW: 0.50, Lambda: 0.050):');
  console.log(`  ${defaultResult.totalMeasurements} measurements, ${defaultResult.bucketsWithData}/9 buckets`);
  console.log('  Bucket details:');
  for (const bd of defaultResult.bucketDetails) {
    console.log(`    RPM[${bd.rpm}] Load[${bd.load}]: ${bd.count} measurements, median: ${bd.median}ms`);
  }
}

// Analysis insights
console.log('\nInsights:');
console.log(`  - Loosest thresholds: PW: ${Math.min(...pwThresholds)}, Lambda: ${Math.min(...lambdaThresholds)}`);
console.log(`  - Tightest thresholds: PW: ${Math.max(...pwThresholds)}, Lambda: ${Math.max(...lambdaThresholds)}`);
console.log(`  - Max measurements found: ${Math.max(...results.map(r => r.totalMeasurements))}`);
console.log(`  - Max bucket coverage: ${Math.max(...results.map(r => r.bucketsWithData))}/9`);
