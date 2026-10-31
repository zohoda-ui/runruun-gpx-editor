/**
 * Test script to run full OSRM Match optimization on Incheon Marathon GPX
 */

const fs = require('fs');
const path = require('path');
const OSRMOptimizer = require('./osrm-optimizer.js');

const GPX_PATH = '/Users/admin/Downloads/인천마라톤풀코스(스트라바).gpx';

console.log('Loading Incheon Marathon GPX...');
const content = fs.readFileSync(GPX_PATH, 'utf8');

// Parse trkpts
const ptRegex = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"(?:\s*\/?>|>([\s\S]*?)<\/trkpt>)/g;
const eleRegex = /<ele>([^<]+)<\/ele>/;
const timeRegex = /<time>([^<]+)<\/time>/;

const points = [];
let match;
while ((match = ptRegex.exec(content)) !== null) {
  const lat = parseFloat(match[1]);
  const lon = parseFloat(match[2]);
  const body = match[3] || '';
  const eleMatch = eleRegex.exec(body);
  const timeMatch = timeRegex.exec(body);
  const ele = eleMatch ? parseFloat(eleMatch[1]) : 0.0;
  const time = timeMatch ? timeMatch[1] : null;
  points.push({ lat, lon, ele, time, trkIdx: 0, segIdx: 0 });
}

console.log(`Parsed ${points.length} points.`);

async function main() {
  console.log('\n--- Starting Optimized OSRM Match ---');
  const t0 = Date.now();

  const result = await OSRMOptimizer.matchPointsOptimized(points, {
    profile: 'driving',
    concurrency: 2,
    epsilonMeters: 2.5,
    maxGapMeters: 200.0,
    onProgress: (p) => {
      process.stdout.write(`\rProgress: ${p.completed} / ${p.total} chunks (${p.percent}%)`);
    }
  });

  const totalTime = Date.now() - t0;
  console.log('\n\n--- Optimization Results ---');
  console.log(`Original points count:      ${result.preprocessing.originalCount.toLocaleString()}`);
  console.log(`Reduced points count:       ${result.preprocessing.reducedCount.toLocaleString()}`);
  console.log(`Point reduction ratio:      ${result.preprocessing.reductionRatio}%`);
  console.log(`Total OSRM chunks:          ${result.totalChunks} (vs 1,953 in legacy)`);
  console.log(`Chunk success rate:         ${result.successChunks} / ${result.totalChunks} (${((result.successChunks / result.totalChunks)*100).toFixed(1)}%)`);
  console.log(`Average confidence:         ${result.avgConfidence}%`);
  console.log(`Matched points count:       ${result.matchedPoints.length.toLocaleString()}`);
  console.log('\n--- Timings ---');
  console.log(`Preprocessing time:         ${result.timings.preprocessingMs} ms`);
  console.log(`Network wait time:          ${result.timings.networkWaitMs} ms`);
  console.log(`Elevation interp time:      ${result.timings.elevationInterpolationMs} ms`);
  console.log(`Total processing time:      ${(totalTime / 1000).toFixed(2)} seconds (vs 5~10 mins in legacy!)`);

  // Verify elevation and time preservation
  const firstOrig = points[0];
  const lastOrig = points[points.length - 1];
  const firstMatched = result.matchedPoints[0];
  const lastMatched = result.matchedPoints[result.matchedPoints.length - 1];

  console.log('\n--- Data Preservation Check ---');
  console.log(`Start Ele: Orig=${firstOrig.ele}m vs Matched=${firstMatched.ele}m`);
  console.log(`End Ele:   Orig=${lastOrig.ele}m vs Matched=${lastMatched.ele}m`);
  console.log(`Start Time: Orig=${firstOrig.time} vs Matched=${firstMatched.time}`);
  console.log(`End Time:   Orig=${lastOrig.time} vs Matched=${lastMatched.time}`);

  fs.writeFileSync(
    path.resolve(__dirname, 'incheon_optimization_result.json'),
    JSON.stringify({
      summary: {
        originalCount: result.preprocessing.originalCount,
        reducedCount: result.preprocessing.reducedCount,
        reductionRatio: result.preprocessing.reductionRatio,
        totalChunks: result.totalChunks,
        successChunks: result.successChunks,
        failedChunks: result.failedChunks,
        avgConfidence: result.avgConfidence,
        totalTimeSeconds: Math.round(totalTime / 10) / 100
      },
      timings: result.timings
    }, null, 2),
    'utf8'
  );
}

main().catch(err => {
  console.error('\nTest failed:', err);
  process.exit(1);
});
