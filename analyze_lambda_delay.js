#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
  MIN_RPM: 500,           // Minimum RPM to consider valid data
  MIN_PW: 1.0,            // Minimum pulsewidth (ms) to consider
  PW_CHANGE_THRESHOLD: 0.5, // Minimum PW change to detect (ms)
  LAMBDA_CHANGE_THRESHOLD: 0.05, // Minimum lambda change to detect
  MAX_DELAY_MS: 2000,     // Maximum reasonable delay (ms)
  BUCKET_COUNT: 3         // 3x3 grid
};

class LambdaDelayAnalyzer {
  constructor(filename, config = null) {
    this.filename = filename;
    this.config = config || CONFIG;
    this.data = [];
    this.buckets = Array.from({ length: this.config.BUCKET_COUNT }, () =>
      Array.from({ length: this.config.BUCKET_COUNT }, () => ({
        data: [],
        delays: []
      }))
    );
  }

  // Parse TSV file
  parseFile() {
    console.log(`Reading file: ${this.filename}`);
    const content = fs.readFileSync(this.filename, 'utf-8');
    const lines = content.split('\n');

    // Line 3 (index 2) contains headers
    const headers = lines[2].split('\t');
    const timeIdx = headers.indexOf('Time');
    const rpmIdx = headers.indexOf('RPM');
    const pwIdx = headers.indexOf('PW');
    const lambdaIdx = headers.indexOf('Lambda');
    const loadIdx = headers.indexOf('FuelLoad');

    if (timeIdx === -1 || rpmIdx === -1 || pwIdx === -1 || lambdaIdx === -1 || loadIdx === -1) {
      throw new Error('Required columns not found in file');
    }

    // Parse data starting from line 4 (index 3)
    for (let i = 3; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const fields = line.split('\t');
      const time = parseFloat(fields[timeIdx]);
      const rpm = parseFloat(fields[rpmIdx]);
      const pw = parseFloat(fields[pwIdx]);
      const lambda = parseFloat(fields[lambdaIdx]);
      const load = parseFloat(fields[loadIdx]);

      // Filter invalid data
      if (isNaN(time) || isNaN(rpm) || isNaN(pw) || isNaN(lambda) || isNaN(load)) continue;
      if (rpm < this.config.MIN_RPM || pw < this.config.MIN_PW) continue;

      this.data.push({ time, rpm, pw, lambda, load });
    }

    console.log(`Loaded ${this.data.length} valid data points`);
  }

  // Determine bucket boundaries based on data distribution
  calculateBucketBoundaries() {
    const rpms = this.data.map(d => d.rpm).sort((a, b) => a - b);
    const loads = this.data.map(d => d.load).sort((a, b) => a - b);

    const percentile = (arr, p) => arr[Math.floor(arr.length * p)];

    this.rpmBoundaries = [
      rpms[0],
      percentile(rpms, 1/3),
      percentile(rpms, 2/3),
      rpms[rpms.length - 1]
    ];

    this.loadBoundaries = [
      loads[0],
      percentile(loads, 1/3),
      percentile(loads, 2/3),
      loads[loads.length - 1]
    ];

    console.log(`\nRPM boundaries: ${this.rpmBoundaries.map(r => r.toFixed(0)).join(', ')}`);
    console.log(`Load boundaries: ${this.loadBoundaries.map(l => l.toFixed(1)).join(', ')}`);
  }

  // Assign data points to buckets
  assignToBuckets() {
    for (const point of this.data) {
      const rpmBucket = this.getBucketIndex(point.rpm, this.rpmBoundaries);
      const loadBucket = this.getBucketIndex(point.load, this.loadBoundaries);

      if (rpmBucket !== -1 && loadBucket !== -1) {
        this.buckets[rpmBucket][loadBucket].data.push(point);
      }
    }

    // Report bucket populations
    console.log('\nBucket populations:');
    for (let i = 0; i < this.config.BUCKET_COUNT; i++) {
      for (let j = 0; j < this.config.BUCKET_COUNT; j++) {
        console.log(`  RPM[${i}] Load[${j}]: ${this.buckets[i][j].data.length} points`);
      }
    }
  }

  getBucketIndex(value, boundaries) {
    for (let i = 0; i < this.config.BUCKET_COUNT; i++) {
      if (value >= boundaries[i] && value < boundaries[i + 1]) {
        return i;
      }
    }
    // Handle edge case for maximum value
    if (value === boundaries[this.config.BUCKET_COUNT]) {
      return this.config.BUCKET_COUNT - 1;
    }
    return -1;
  }

  // Calculate delays for each bucket
  calculateDelays() {
    console.log('\nCalculating delays...');

    for (let i = 0; i < this.config.BUCKET_COUNT; i++) {
      for (let j = 0; j < this.config.BUCKET_COUNT; j++) {
        const bucket = this.buckets[i][j];
        if (bucket.data.length < 10) {
          console.log(`  RPM[${i}] Load[${j}]: Insufficient data`);
          continue;
        }

        bucket.delays = this.findDelaysInSequence(bucket.data);
        console.log(`  RPM[${i}] Load[${j}]: Found ${bucket.delays.length} delay measurements`);
      }
    }
  }

  // Find delays by detecting PW changes and corresponding Lambda responses
  findDelaysInSequence(data) {
    const delays = [];

    // Sort by time to ensure sequential processing
    data.sort((a, b) => a.time - b.time);

    for (let i = 1; i < data.length - 1; i++) {
      const prev = data[i - 1];
      const curr = data[i];

      // Detect significant PW change
      const pwChange = curr.pw - prev.pw;
      if (Math.abs(pwChange) < this.config.PW_CHANGE_THRESHOLD) continue;

      // Look ahead for lambda response (inverse correlation)
      // PW increase -> Lambda should decrease (richer)
      // PW decrease -> Lambda should increase (leaner)
      const expectedLambdaDirection = -Math.sign(pwChange);

      for (let j = i + 1; j < Math.min(i + 100, data.length); j++) {
        const future = data[j];
        const lambdaChange = future.lambda - curr.lambda;
        const timeDiff = (future.time - curr.time) * 1000; // Convert to ms

        // Check if lambda moved in expected direction
        if (Math.sign(lambdaChange) === expectedLambdaDirection &&
            Math.abs(lambdaChange) >= this.config.LAMBDA_CHANGE_THRESHOLD &&
            timeDiff <= this.config.MAX_DELAY_MS) {
          delays.push(timeDiff);
          break; // Found response for this PW change
        }
      }
    }

    return delays;
  }

  // Calculate median of an array
  median(arr) {
    if (arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  // Generate the 3x3 delay table
  generateTable() {
    console.log('\n=== LAMBDA DELAY TABLE (milliseconds) ===\n');

    const table = [];

    // Use midpoint of each bucket range as the axis value
    const rpmValues = [];
    const loadValues = [];

    for (let i = 0; i < this.config.BUCKET_COUNT; i++) {
      const rpmMid = (this.rpmBoundaries[i] + this.rpmBoundaries[i + 1]) / 2;
      rpmValues.push(Math.round(rpmMid));

      const loadMid = (this.loadBoundaries[i] + this.loadBoundaries[i + 1]) / 2;
      loadValues.push(Math.round(loadMid));
    }

    // Header
    let header = 'RPM \\ Load'.padEnd(12);
    for (let j = 0; j < this.config.BUCKET_COUNT; j++) {
      header += String(loadValues[j]).padEnd(12);
    }
    console.log(header);
    console.log('-'.repeat(48));

    // Data rows
    for (let i = 0; i < this.config.BUCKET_COUNT; i++) {
      const row = { rpm: rpmValues[i], load: loadValues, delays: [] };
      let line = String(rpmValues[i]).padEnd(12);

      for (let j = 0; j < this.config.BUCKET_COUNT; j++) {
        const bucket = this.buckets[i][j];
        const delay = this.median(bucket.delays);

        // Round to 1 decimal place for JSON export
        const roundedDelay = delay !== null ? Math.round(delay * 10) / 10 : null;
        row.delays.push(roundedDelay);

        if (roundedDelay !== null) {
          line += `${roundedDelay.toFixed(1)}`.padEnd(12);
        } else {
          line += 'N/A'.padEnd(12);
        }
      }

      console.log(line);
      table.push(row);
    }

    // Store axis values for export
    this.rpmAxisValues = rpmValues;
    this.loadAxisValues = loadValues;

    return table;
  }

  // Export results to JSON
  exportResults(table) {
    const output = {
      metadata: {
        sourceFile: this.filename,
        generatedAt: new Date().toISOString(),
        totalDataPoints: this.data.length,
        config: CONFIG
      },
      rpmAxis: this.rpmAxisValues,
      loadAxis: this.loadAxisValues,
      boundaries: {
        rpm: this.rpmBoundaries,
        load: this.loadBoundaries
      },
      delayTable: table,
      detailedBuckets: []
    };

    // Add detailed bucket information
    for (let i = 0; i < this.config.BUCKET_COUNT; i++) {
      for (let j = 0; j < this.config.BUCKET_COUNT; j++) {
        const bucket = this.buckets[i][j];
        const medianDelay = this.median(bucket.delays);
        const minDelay = bucket.delays.length > 0 ? Math.min(...bucket.delays) : null;
        const maxDelay = bucket.delays.length > 0 ? Math.max(...bucket.delays) : null;

        output.detailedBuckets.push({
          rpmBucket: i,
          loadBucket: j,
          dataPoints: bucket.data.length,
          delayMeasurements: bucket.delays.length,
          medianDelay: medianDelay !== null ? Math.round(medianDelay * 10) / 10 : null,
          minDelay: minDelay !== null ? Math.round(minDelay * 10) / 10 : null,
          maxDelay: maxDelay !== null ? Math.round(maxDelay * 10) / 10 : null
        });
      }
    }

    const outputFile = 'lambda_delay_table.json';
    fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
    console.log(`\nResults exported to: ${outputFile}`);
  }

  // Main analysis workflow
  analyze() {
    try {
      this.parseFile();
      this.calculateBucketBoundaries();
      this.assignToBuckets();
      this.calculateDelays();
      const table = this.generateTable();
      this.exportResults(table);

      console.log('\nAnalysis complete!');
    } catch (error) {
      console.error('Error during analysis:', error.message);
      process.exit(1);
    }
  }
}

// Main execution
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: node analyze_lambda_delay.js <logfile.msl>');
    process.exit(1);
  }

  const filename = args[0];

  if (!fs.existsSync(filename)) {
    console.error(`Error: File not found: ${filename}`);
    process.exit(1);
  }

  const analyzer = new LambdaDelayAnalyzer(filename);
  analyzer.analyze();
}

module.exports = LambdaDelayAnalyzer;
