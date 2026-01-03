# Lambda Delay Analysis Tool

A JavaScript/Node.js program that analyzes engine log data to estimate lambda sensor delay times across different engine operating conditions (RPM and load).

## Overview

Lambda sensors (oxygen sensors) have an inherent delay between when fuel is injected and when the sensor reports the change in exhaust gas composition. This delay varies based on engine speed and load due to:
- Exhaust gas travel time to the sensor
- Sensor response time
- Engine breathing characteristics at different operating points

This tool analyzes log data to create a 3×3 lookup table of delay values that can be used for delay compensation and bilinear interpolation in real-time applications.

## Installation

```bash
npm install  # No external dependencies required
```

## Usage

### Basic Analysis

```bash
node analyze_lambda_delay.js <logfile.msl>
```

Example:
```bash
node analyze_lambda_delay.js example/2025-07-09_11-35-15.msl
```

### Output

The program generates:

1. **Console output** showing the 3×3 delay table
2. **lambda_delay_table.json** containing:
   - RPM axis values (bucket midpoints)
   - Load axis values (bucket midpoints)
   - 3×3 delay matrix (in milliseconds)
   - Detailed statistics for each bucket
   - Configuration parameters used

Example output:
```
=== LAMBDA DELAY TABLE (milliseconds) ===

RPM \ Load  24          37          69
------------------------------------------------
1006        N/A         N/A         646.5
1655        N/A         558.0       240.5
3124        282.5       159.0       269.0
```

## How It Works

### Algorithm

1. **Data Parsing**: Reads TSV log files with Time, RPM, FuelLoad, PW (pulsewidth), and Lambda columns
2. **Bucketing**: Divides the operating range into a 3×3 grid based on RPM and load percentiles
3. **Delay Detection**:
   - Detects significant PW changes (fuel injection changes)
   - Looks ahead for corresponding inverse Lambda responses (PW↑ → Lambda↓)
   - Measures the time delay between the two events
4. **Aggregation**: Uses median delay values for each bucket to handle outliers

### Configuration Parameters

Key parameters in the algorithm (configurable via constructor):

```javascript
const config = {
  MIN_RPM: 500,              // Minimum RPM to consider
  MIN_PW: 1.0,               // Minimum pulsewidth (ms)
  PW_CHANGE_THRESHOLD: 0.5,  // Minimum PW change to detect (ms)
  LAMBDA_CHANGE_THRESHOLD: 0.05, // Minimum lambda change
  MAX_DELAY_MS: 2000,        // Maximum reasonable delay (ms)
  BUCKET_COUNT: 3            // 3×3 grid
};
```

## Sensitivity Analysis

### Threshold Impact on Data Coverage

The choice of `PW_CHANGE_THRESHOLD` and `LAMBDA_CHANGE_THRESHOLD` significantly affects how many delay measurements are detected:

| PW Threshold | Lambda Threshold | Measurements | Bucket Coverage |
|--------------|------------------|--------------|-----------------|
| 0.2          | 0.02             | 685          | 9/9 (100%)      |
| 0.2          | 0.05             | 521          | 9/9 (100%)      |
| **0.5**      | **0.05**         | **69**       | **6/9 (67%)**   |
| 1.0          | 0.05             | 18           | 4/9 (44%)       |
| 2.0          | 0.05             | 5            | 2/9 (22%)       |

**Key Finding**: Looser thresholds (lower values) detect far more delay events and provide complete bucket coverage.

### Threshold Impact on Delay Values

While the calculated delay values themselves vary significantly (30-50% coefficient of variation) across different threshold settings:

**Example - Bucket RPM[1] Load[2]:**
- PW: 0.2, Lambda: 0.02 → **201.0 ms**
- PW: 0.2, Lambda: 0.05 → **288.5 ms**
- PW: 0.5, Lambda: 0.05 → **240.5 ms**
- PW: 1.0, Lambda: 0.05 → **241.0 ms**

Range: 201-289 ms (30% variation)

### Critical Finding: Lambda Prediction Error is STABLE

Despite the variation in calculated delay values, **the actual lambda prediction error remains virtually identical** across all threshold configurations:

| Bucket | Lambda StdDev Range | Variation |
|--------|---------------------|-----------|
| RPM[0] Load[2] | 0.073 - 0.074 | **1.2%** |
| RPM[1] Load[2] | 0.063 - 0.063 | **0.0%** |
| RPM[2] Load[2] | 0.081 - 0.081 | **0.0%** |
| All 9 buckets | < 1.2% | **STABLE** |

**Analysis Summary:**
```
Analyzed 9 buckets with sufficient data:
  Stable (< 10% variation):    9 buckets ✓
  Moderate (10-25% variation): 0 buckets
  Variable (> 25% variation):  0 buckets
```

### What This Means

1. **Self-Correcting Algorithm**: Different thresholds detect different PW/Lambda events and calculate different delays, but all arrive at equally valid compensation models

2. **Accuracy is Independent of Threshold Choice**: The 6-16% lambda variability represents actual system noise, not algorithm error

3. **Choose for Coverage**: Since accuracy is equivalent across threshold ranges, prefer settings that maximize bucket coverage

4. **Lambda CV by Bucket** (inherent system variability):
   - Best buckets: 6.2-7.4% CV (stable operating regions)
   - Variable buckets: 12.6-16.2% CV (transient/unstable regions)

## Recommendations

### Recommended Threshold Settings

For maximum coverage and reliability:

```javascript
PW_CHANGE_THRESHOLD: 0.2        // Detects smaller fuel changes
LAMBDA_CHANGE_THRESHOLD: 0.02   // Detects smaller lambda responses
```

**Benefits:**
- 9/9 bucket coverage (vs 6/9 with default)
- 10× more measurements (685 vs 69)
- Identical lambda prediction accuracy (< 1.2% variation)
- More robust statistics per bucket

### Current Default Settings

The program defaults are conservative but may miss data:

```javascript
PW_CHANGE_THRESHOLD: 0.5
LAMBDA_CHANGE_THRESHOLD: 0.05
```

These work but provide limited coverage. Consider adjusting based on your data characteristics.

## Advanced Usage

### Testing Different Thresholds

```bash
node test_thresholds.js
```

Runs sensitivity analysis across multiple threshold combinations and reports:
- Total measurements per configuration
- Bucket coverage statistics
- Comparative analysis

### Validating Delay Accuracy

```bash
node validate_delays.js
```

Validates the calculated delays by:
- Using delays to predict lambda from historical PW values
- Calculating lambda variance with delay compensation
- Comparing accuracy across threshold configurations

### Custom Configuration

```javascript
const LambdaDelayAnalyzer = require('./analyze_lambda_delay.js');

const customConfig = {
  MIN_RPM: 500,
  MIN_PW: 1.0,
  PW_CHANGE_THRESHOLD: 0.2,
  LAMBDA_CHANGE_THRESHOLD: 0.02,
  MAX_DELAY_MS: 2000,
  BUCKET_COUNT: 3
};

const analyzer = new LambdaDelayAnalyzer('myfile.msl', customConfig);
analyzer.analyze();
```

## Input File Format

The program expects tab-separated value (TSV) files with:
- Line 1: Header/version info (ignored)
- Line 2: Capture date/metadata (ignored)
- Line 3: Column headers
- Line 4+: Data rows

**Required columns:**
- `Time` - Timestamp in seconds
- `RPM` - Engine speed
- `FuelLoad` - Load value (typically MAP or calculated load)
- `PW` - Pulsewidth in milliseconds
- `Lambda` - Lambda sensor reading

Example from Speeduino .msl format.

## Output Format

### JSON Structure

```json
{
  "metadata": {
    "sourceFile": "example.msl",
    "generatedAt": "2026-01-03T12:00:00.000Z",
    "totalDataPoints": 27318,
    "config": { ... }
  },
  "rpmAxis": [1006, 1655, 3124],
  "loadAxis": [24, 37, 69],
  "boundaries": {
    "rpm": [599, 1412, 1898, 4350],
    "load": [14, 33, 41, 97]
  },
  "delayTable": [
    {
      "rpm": 1006,
      "load": [24, 37, 69],
      "delays": [null, null, 646.5]
    },
    ...
  ],
  "detailedBuckets": [
    {
      "rpmBucket": 0,
      "loadBucket": 0,
      "dataPoints": 2450,
      "delayMeasurements": 0,
      "medianDelay": null,
      "minDelay": null,
      "maxDelay": null
    },
    ...
  ]
}
```

### Using Results for Bilinear Interpolation

The output format is optimized for bilinear interpolation:

```javascript
const data = require('./lambda_delay_table.json');

function interpolateDelay(rpm, load) {
  // Find surrounding points in rpmAxis and loadAxis
  // Perform bilinear interpolation on delayTable
  // Return interpolated delay value
}

// Example: Get delay for RPM=2000, Load=45
const delay = interpolateDelay(2000, 45);
```

## Interpretation Guide

### Understanding the Results

**Delay Values:**
- Typical range: 100-700 ms
- Higher at low RPM (slower exhaust flow)
- Varies with load (affects exhaust velocity)
- Lower at high RPM (faster exhaust flow)

**N/A Entries:**
- Insufficient data in that operating region
- May indicate:
  - Limited time spent in that RPM/load range
  - Steady-state operation (no PW changes detected)
  - Need for looser thresholds

**Measurement Counts:**
- More measurements = more reliable estimate
- Aim for 10+ measurements per bucket
- Median handles outliers effectively

### Lambda Variability (CV%)

The coefficient of variation in lambda readings indicates:
- **< 10% CV**: Stable operating region, good delay compensation
- **10-15% CV**: Moderate variability, still acceptable
- **> 15% CV**: High variability, may indicate transient operation or sensor noise

This variability is **inherent to the system**, not algorithm error.

## Limitations

1. **Assumes inverse correlation**: Algorithm assumes PW↑ → Lambda↓ (richer mixture)
2. **Requires dynamic operation**: Steady-state operation produces no delay measurements
3. **Single delay per bucket**: Uses median, doesn't capture delay variation within bucket
4. **Linear interpolation**: Real delays may have nonlinear behavior at boundaries

## Technical Notes

### Why Median Instead of Mean?

- Robust to outliers from sensor glitches
- Better represents typical delay in presence of noise
- More stable across threshold variations

### Correlation Analysis

The validation script reports PW-Lambda correlation coefficients:
- Negative correlation expected (inverse relationship)
- Magnitude indicates strength of relationship
- Values around 0.3-0.5 are typical for delayed systems

## Troubleshooting

**No delay measurements found:**
- Lower the PW_CHANGE_THRESHOLD and LAMBDA_CHANGE_THRESHOLD
- Check that log contains dynamic operation (not just idle)
- Verify required columns are present

**Too few buckets with data:**
- Use looser thresholds (e.g., 0.2 / 0.02)
- Check data spans full RPM/load range
- Consider reducing BUCKET_COUNT to 2×2

**Unrealistic delay values (> 1500ms):**
- Decrease MAX_DELAY_MS
- May indicate false correlations
- Check for data quality issues

## Performance

### Parallel Processing

For analyzing multiple log files, use the parallelized meta-analysis:

```bash
node meta_analysis_parallel.js
```

**Performance Comparison:**
- **Sequential (`meta_analysis.js`):** ~60+ seconds for 25 files
- **Parallel (`meta_analysis_parallel.js`):** **~0.8 seconds for 25 files**
- **Speedup:** Approximately **75× faster**

The parallel version automatically uses all available CPU cores for maximum performance.

## Files

- `analyze_lambda_delay.js` - Main analysis program
- `meta_analysis_parallel.js` - **Parallel multi-file analysis (recommended)**
- `meta_analysis.js` - Sequential multi-file analysis
- `test_thresholds.js` - Threshold sensitivity analysis
- `validate_delays.js` - Delay accuracy validation
- `compare_thresholds.js` - Detailed threshold comparison
- `lambda_delay_table.json` - Output file (generated)

## License

ISC

## Author

Generated for engine tuning and lambda delay compensation analysis.
