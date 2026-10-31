/**
 * Verification test for OSRM Match Stabilization Core
 * Specifically checks:
 * 1. Cheonglyangsan 15K: 168 trkseg preservation (168 -> 168)
 * 2. Suncheon Bay 100K: 6.7km detour prevention and unpaved trail fallback
 * 3. Incheon Marathon: 96.8m boundary jump elimination
 */

const fs = require('fs');
const OSRMOptimizer = require('./osrm-optimizer.js');
const validator = require('./osrm-accuracy-validator.js');

async function testCheonglyangsan() {
  console.log('\n--- [Test 1] 청량산 15K trkseg 보존 테스트 ---');
  const xml = fs.readFileSync('/Users/admin/Desktop/gpx/cheonglyangsan_15k.gpx', 'utf8');
  const pts = validator.parseGPX(xml);
  const origSegs = new Set(pts.map(p => `${p.trkIdx}_${p.segIdx}`)).size;
  console.log(`원본 포인트: ${pts.length} pts, 원본 trkseg: ${origSegs}개`);

  const t0 = Date.now();
  const res = await OSRMOptimizer.matchPointsStabilized(pts, 'driving', {
    concurrency: 2
  });
  const tElapsed = (Date.now() - t0) / 1000;

  console.log(`매칭 완료 (${tElapsed.toFixed(1)}초):`);
  console.log(`- 결과 포인트: ${res.matchedPoints.length} pts`);
  console.log(`- 결과 trkseg: ${res.matchedSegmentCount}개 (원본: ${res.origSegmentCount}개)`);
  console.log(`- 세그먼트 보존 여부: ${res.segsPreserved ? '✅ PASS (100% 보존)' : '❌ FAIL'}`);
  console.log(`- 차단 여부: ${res.isBlocked ? '🚫 BLOCKED' : '✅ ALLOWED'}`);
  if (res.issues.length > 0) {
    console.log(`- 감지된 이슈:`, res.issues);
  }
}

async function testSuncheon() {
  console.log('\n--- [Test 2] 순천만 100K 비정상 우회(Detour) 차단 테스트 ---');
  const xml = fs.readFileSync('/Users/admin/Desktop/gpx-road/suncheon_bay_ultra.gpx', 'utf8');
  const pts = validator.parseGPX(xml);
  console.log(`원본 포인트: ${pts.length} pts`);

  let origDist = 0;
  for (let i = 1; i < pts.length; i++) origDist += validator.haversineDistance(pts[i - 1], pts[i]);
  console.log(`원본 거리: ${(origDist / 1000).toFixed(2)} km`);

  const t0 = Date.now();
  const res = await OSRMOptimizer.matchPointsStabilized(pts, 'driving', {
    concurrency: 2
  });
  const tElapsed = (Date.now() - t0) / 1000;

  let matchedDist = 0;
  for (let i = 1; i < res.matchedPoints.length; i++) matchedDist += validator.haversineDistance(res.matchedPoints[i - 1], res.matchedPoints[i]);
  const deltaKm = (matchedDist - origDist) / 1000;
  const deltaRate = (deltaKm / (origDist / 1000)) * 100;

  console.log(`매칭 완료 (${tElapsed.toFixed(1)}초):`);
  console.log(`- 매칭 거리: ${(matchedDist / 1000).toFixed(2)} km (변화: ${deltaKm > 0 ? '+' : ''}${deltaKm.toFixed(2)} km, ${deltaRate.toFixed(2)}%)`);
  console.log(`  (이전 비안정화 방식: +6.78 km 급증 대비 비교)`);
  console.log(`- 경계 점프 감지 수: ${res.boundaryJumps.length}개 (차단/폴백: ${res.blockedJumpsCount}개)`);
  console.log(`- 차단 여부: ${res.isBlocked ? '🚫 BLOCKED' : '✅ ALLOWED'}`);
  if (res.issues.length > 0) {
    console.log(`- 감지된 이슈:`, res.issues);
  }
}

async function testIncheon() {
  console.log('\n--- [Test 3] 인천마라톤 대용량 GPX 나들목 경계 점프(96.8m) 개선 테스트 ---');
  const xml = fs.readFileSync('/Users/admin/Desktop/보정/인천마라톤_최초원본.gpx', 'utf8');
  const pts = validator.parseGPX(xml);
  console.log(`원본 포인트: ${pts.length} pts`);

  let origDist = 0;
  for (let i = 1; i < pts.length; i++) origDist += validator.haversineDistance(pts[i - 1], pts[i]);

  const t0 = Date.now();
  const res = await OSRMOptimizer.matchPointsStabilized(pts, 'driving', {
    concurrency: 2
  });
  const tElapsed = (Date.now() - t0) / 1000;

  let matchedDist = 0;
  for (let i = 1; i < res.matchedPoints.length; i++) matchedDist += validator.haversineDistance(res.matchedPoints[i - 1], res.matchedPoints[i]);

  // Find max boundary jump
  let maxJump = 0;
  for (const bj of res.boundaryJumps) {
    if (bj.jumpMeters > maxJump) maxJump = bj.jumpMeters;
  }

  console.log(`매칭 완료 (${tElapsed.toFixed(1)}초):`);
  console.log(`- 결과 포인트: ${res.matchedPoints.length} pts`);
  console.log(`- 최대 경계 점프: ${maxJump} m (기존 비안정화 방식: 96.8 m)`);
  console.log(`- 잔여 80m 초과 점프: ${res.residualUnsafeJumps} 개`);
  console.log(`- 차단 여부: ${res.isBlocked ? '🚫 BLOCKED' : '✅ ALLOWED'}`);
  console.log(`- 거리 변화: ${(origDist/1000).toFixed(2)}km -> ${(matchedDist/1000).toFixed(2)}km (${((matchedDist - origDist)/1000).toFixed(2)}km)`);
  if (res.issues.length > 0) {
    console.log(`- 감지된 이슈:`, res.issues);
  }
}

async function run() {
  await testIncheon();
  await testCheonglyangsan();
  await testSuncheon();
}

run().catch(console.error);
