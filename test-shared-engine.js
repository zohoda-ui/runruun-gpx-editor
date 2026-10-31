/**
 * RunRuun Shared Elevation Engine 단위 테스트 및 GPX 벤치마크 검증 스크립트
 */
const fs = require('fs');
const path = require('path');
const engine = require('./runruun-shared-elevation-engine.js');

console.log("======================================================================");
console.log("RunRuun Shared Elevation Engine v" + engine.version + " - Phase 1 정밀 검증");
console.log("======================================================================\n");

let passedCount = 0;
let failedCount = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`[PASS] ${testName}`);
    passedCount++;
  } else {
    console.error(`[FAIL] ${testName}`);
    failedCount++;
    throw new Error(`Assertion failed: ${testName}`);
  }
}

// --------------------------------------------------------------------
// [테스트 1] haversineDistance 기본 연산 및 예외 처리
// --------------------------------------------------------------------
console.log("▶ [테스트 1] haversineDistance 검증");
const pA = { lat: 37.5665, lon: 126.9780 }; // 서울시청
const pB = { lat: 35.1796, lon: 129.0756 }; // 부산시청
const distM = engine.haversineDistance(pA, pB, 'm');
const distKm = engine.haversineDistance(pA, pB, 'km');

assert(Math.abs(distM - 325000) < 5000, "서울-부산 거리 계산 정합성 (~325km)");
assert(Math.abs(distKm - (distM / 1000)) < 0.0001, "m 및 km 단위 변환 일관성");
assert(engine.haversineDistance(pA, pA) === 0, "동일 좌표 간 거리 0m");
assert(engine.haversineDistance(null, pB) === 0, "null 좌표 전달 시 0m 방어");
assert(engine.haversineDistance({ lat: NaN, lon: 126 }, pB) === 0, "NaN 좌표 전달 시 0m 방어");

// --------------------------------------------------------------------
// [테스트 2] 입력 배열 불변성 (Immutability) 검증
// --------------------------------------------------------------------
console.log("\n▶ [테스트 2] 입력 배열 불변성 (Immutability) 검증");
const samplePoints = [
  { lat: 37.0, lon: 127.0, ele: 100 },
  { lat: 37.001, lon: 127.001, ele: 120 },
  { lat: 37.002, lon: 127.002, ele: 110 }
];
const snapshotJson = JSON.stringify(samplePoints);

engine.calculateCumulativeDistances(samplePoints);
engine.resamplePoints(samplePoints, 10.0);
engine.limitGradientSpikes(samplePoints, 0.15);
engine.spatialGaussianSmooth(samplePoints, 15.0);
engine.interpolateElevations(samplePoints);
engine.calculateElevationStats(samplePoints, { method: 'raw' });

assert(JSON.stringify(samplePoints) === snapshotJson, "모든 연산 후 원본 samplePoints 배열 100% 불변 유지");

// --------------------------------------------------------------------
// [테스트 3] 결측 고도 처리 및 0m 임의 대입 금지 검증
// --------------------------------------------------------------------
console.log("\n▶ [테스트 3] 결측 고도 처리 및 0m 임의 대입 금지 검증");
const missingPoints = [
  { lat: 37.0, lon: 127.0, ele: null },
  { lat: 37.001, lon: 127.001, ele: 100 },
  { lat: 37.002, lon: 127.002, ele: null },
  { lat: 37.003, lon: 127.003, ele: 150 },
  { lat: 37.004, lon: 127.004, ele: null }
];
const interpRes = engine.interpolateElevations(missingPoints);

assert(interpRes.points[0].ele === 100, "앞부분 결측치 첫 유효값(100m) 채움");
assert(interpRes.points[2].ele === 125, "중간 결측치 거리 선형 보간 (125m)");
assert(interpRes.points[4].ele === 150, "뒷부분 결측치 마지막 유효값(150m) 채움");
assert(interpRes.missingCount === 3, "결측치 개수 3개 정확히 보고");
assert(interpRes.allMissing === false, "allMissing: false 확인");

const allNullPoints = [
  { lat: 37.0, lon: 127.0, ele: null },
  { lat: 37.001, lon: 127.001, ele: null }
];
const allNullRes = engine.interpolateElevations(allNullPoints);
assert(allNullRes.allMissing === true, "전체 결측 시 allMissing: true 확인");
assert(allNullRes.points[0].ele === null, "전체 결측 시 0m로 변환하지 않고 null 유지");

// --------------------------------------------------------------------
// [테스트 4] D+ / D- 누적 연산기 (Threshold vs Hysteresis) 결정성 검증
// --------------------------------------------------------------------
console.log("\n▶ [테스트 4] D+ / D- 누적 연산기 결정성 및 수치 검증");
const stepEles = [100, 100.5, 100.8, 102.0, 101.5, 99.0, 104.0];

const dPlusRaw = engine.calculateDPlus(stepEles, { mode: 'raw' });
const dMinusRaw = engine.calculateDMinus(stepEles, { mode: 'raw' });
// raw: +0.5, +0.3, +1.2 (+2.0) | -0.5, -2.5 (-3.0) | +5.0 (+5.0) => D+: 7.0m, D-: 3.0m
assert(dPlusRaw === 7, `Raw D+ 계산 정확성: ${dPlusRaw}m (기대 7m)`);
assert(dMinusRaw === 3, `Raw D- 계산 정확성: ${dMinusRaw}m (기대 3m)`);

// 1m threshold: 100 -> 102(+2) -> 99(-3) -> 104(+5) => D+: 7m, D-: 3m
const dPlusTh1 = engine.calculateDPlus(stepEles, { mode: 'threshold', threshold: 1.0 });
assert(dPlusTh1 === 7, `1m Threshold D+ 계산 정확성: ${dPlusTh1}m (기대 7m)`);

// 100회 반복 결정성(Determinism) 검증
let isDeterministic = true;
for (let iter = 0; iter < 100; iter++) {
  if (engine.calculateDPlus(stepEles, { mode: 'threshold', threshold: 1.0 }) !== 7) {
    isDeterministic = false;
    break;
  }
}
assert(isDeterministic, "동일 입력 100회 반복 계산 결정성 100% 확인");

// --------------------------------------------------------------------
// [테스트 5] 5대 GPX 파일 대상 11대 계산 모드 벤치마크 및 비교
// --------------------------------------------------------------------
console.log("\n======================================================================");
console.log("▶ [테스트 5] 5대 GPX 파일 대상 11대 계산 모드 벤치마크");
console.log("======================================================================");

function parseGpxSimple(xmlText) {
  const points = [];
  const trkptRegex = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/gi;
  const eleRegex = /<ele>([^<]+)<\/ele>/i;
  let match;
  while ((match = trkptRegex.exec(xmlText)) !== null) {
    const lat = parseFloat(match[1]);
    const lon = parseFloat(match[2]);
    const body = match[3];
    const eleMatch = eleRegex.exec(body);
    const ele = eleMatch ? parseFloat(eleMatch[1]) : null;
    points.push({ lat, lon, ele });
  }
  return points;
}

const gpxFiles = [
  { name: "cheonglyangsan_15k.gpx", path: "/Users/admin/Desktop/gpx/cheonglyangsan_15k.gpx", type: "trail" },
  { name: "dynafit_taebaek_trail.gpx", path: "/Users/admin/Desktop/gpx/dynafit_taebaek_trail.gpx", type: "trail" },
  { name: "chuncheon_full.gpx", path: "/Users/admin/Desktop/gpx-road/chuncheon_full.gpx", type: "road" },
  { name: "suncheon_bay_ultra.gpx", path: "/Users/admin/Desktop/gpx-road/suncheon_bay_ultra.gpx", type: "road" },
  { name: "YTN_seoulmarathon.gpx", path: "/Users/admin/Desktop/gpx-road/YTN_seoulmarathon.gpx", type: "road" }
];

const methods = [
  "raw", "threshold_1m", "threshold_3m",
  "gaussian_15m", "gaussian_25m", "gaussian_35m", "gaussian_60m",
  "hysteresis_1m", "hysteresis_3m",
  "dem_measured", "dem_interpolated"
];

const benchmarkSummary = {};

gpxFiles.forEach(fInfo => {
  const xml = fs.readFileSync(fInfo.path, 'utf8');
  const pts = parseGpxSimple(xml);
  console.log(`\n[GPX] ${fInfo.name} (${fInfo.type}, 포인트: ${pts.length}개)`);

  const fileResults = {};

  methods.forEach(m => {
    const res = engine.calculateElevationStats(pts, { method: m });
    fileResults[m] = {
      gain: res.eleGain,
      loss: res.eleLoss,
      distKm: res.totalDistKm,
      pts: res.pointCount,
      minEle: res.minEle,
      maxEle: res.maxEle,
      timeMs: res.computationTimeMs
    };
    console.log(`  - ${m.padEnd(18)}: D+ ${String(res.eleGain).padStart(5)}m, D- ${String(res.eleLoss).padStart(5)}m, Dist: ${res.totalDistKm.toFixed(3)}km, time: ${res.computationTimeMs}ms`);
  });

  benchmarkSummary[fInfo.name] = fileResults;
});

// 청량산 & 순천만 핵심 회귀 검증
const cheong = benchmarkSummary["cheonglyangsan_15k.gpx"];
assert(cheong["raw"].gain === 1810, "청량산 15K Raw D+ 1,810m 일치");
assert(cheong["threshold_1m"].gain === 1810, "청량산 15K 1m Threshold D+ 1,810m 일치");
assert(cheong["hysteresis_1m"].gain === 1810, "청량산 15K 1m Hysteresis D+ 1,810m 일치");

const suncheon = benchmarkSummary["suncheon_bay_ultra.gpx"];
assert(suncheon["raw"].gain === 2545, "순천만 100K Raw D+ 2,545m 일치");
assert(suncheon["threshold_1m"].gain === 2372, "순천만 100K 1m Threshold D+ 2,372m 일치");

// 벤치마크 결과 저장
const outJsonPath = path.join(__dirname, 'phase1_benchmark_results.json');
fs.writeFileSync(outJsonPath, JSON.stringify(benchmarkSummary, null, 2), 'utf8');
console.log(`\n벤치마크 결과 파일 저장 완료: ${outJsonPath}`);

console.log("\n======================================================================");
console.log(`전체 테스트 완료: ${passedCount} PASS / ${failedCount} FAIL`);
console.log("======================================================================");

if (failedCount > 0) {
  process.exit(1);
}
