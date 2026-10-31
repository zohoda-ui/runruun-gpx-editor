/**
 * Comprehensive Accuracy Verification Runner for 6 Real GPX Files
 */

const fs = require('fs');
const path = require('path');
const validator = require('./osrm-accuracy-validator.js');

const GPX_TEST_SUITE = [
  {
    id: 'incheon_full',
    name: '인천마라톤 대용량 GPX',
    type: '대용량 (10,000pts 이상)',
    filePath: '/Users/admin/Desktop/보정/인천마라톤_최초원본.gpx',
    referencePath: '/Users/admin/Desktop/보정/인천마라톤_도로중심선_우회수정본.gpx'
  },
  {
    id: 'suncheon_100k',
    name: '순천만 100K 장거리 GPX',
    type: '초장거리 울트라 (100km)',
    filePath: '/Users/admin/Desktop/gpx-road/suncheon_bay_ultra.gpx',
    referencePath: null
  },
  {
    id: 'cheonglyang_15k',
    name: '청량산 15K 다중 trkseg GPX',
    type: '다중 세그먼트 (168 trkseg)',
    filePath: '/Users/admin/Desktop/gpx/cheonglyangsan_15k.gpx',
    referencePath: null
  },
  {
    id: 'seoul_mbn',
    name: '2025 MBN 서울 도심 마라톤 GPX',
    type: '도심 고층빌딩 협곡 (Urban Canyon)',
    filePath: '/Users/admin/Desktop/gpx-road/2025mbnseoul.gpx',
    referencePath: null
  },
  {
    id: 'siheung_half',
    name: '시흥 하프 마라톤 GPX',
    type: '180도 반환점 및 U턴 코스',
    filePath: '/Users/admin/Desktop/gpx-road/siheung_half_marathon.gpx',
    referencePath: null
  },
  {
    id: 'chuncheon_full',
    name: '춘천마라톤 풀코스 GPX',
    type: '교량·지하차도·호반 하천변 코스',
    filePath: '/Users/admin/Desktop/gpx-road/chuncheon_full.gpx',
    referencePath: null
  }
];

async function runTestSuite() {
  console.log('========================================================================');
  console.log('       RunRuun OSRM Match 정확도 검증 프로젝트 (6개 실측 GPX)        ');
  console.log('========================================================================\n');

  const allResults = [];

  for (let idx = 0; idx < GPX_TEST_SUITE.length; idx++) {
    const testCase = GPX_TEST_SUITE[idx];
    console.log(`\n[${idx + 1}/6] 검증 대상: ${testCase.name} (${testCase.type})`);
    console.log(`      파일 경로: ${testCase.filePath}`);

    if (!fs.existsSync(testCase.filePath)) {
      console.error(`      ❌ 파일을 찾을 수 없습니다: ${testCase.filePath}`);
      continue;
    }

    const xmlText = fs.readFileSync(testCase.filePath, 'utf8');
    const origPoints = validator.parseGPX(xmlText);
    console.log(`      원본 포인트 수: ${origPoints.length.toLocaleString()} pts, 세그먼트: ${new Set(origPoints.map(p => p.segIdx)).size}`);

    // Step 1: Execute OSRM Match
    console.log(`      OSRM Match 도로망 매칭 실행 중...`);
    const t0 = Date.now();
    const matchResult = await validator.runOSRMWithChunkCapture(origPoints, {
      profile: 'driving',
      concurrency: 2,
      onProgress: (done, total) => {
        process.stdout.write(`\r      진행률: ${done} / ${total} 청크 (${Math.round((done / total) * 100)}%)`);
      }
    });
    const matchTimeMs = Date.now() - t0;
    console.log(`\n      매칭 완료 (${(matchTimeMs / 1000).toFixed(1)}초, 성공 청크: ${matchResult.successChunks}/${matchResult.totalChunks}, 매칭 포인트: ${matchResult.matchedPoints.length.toLocaleString()} pts)`);

    // Step 2: Spatial Cross-track Error
    console.log(`      위치 오차 (Cross-track) 계산 중...`);
    const spatial = validator.evaluateSpatialErrors(origPoints, matchResult.matchedPoints);
    console.log(`      - 평균 오차: ${spatial.mean}m, 중앙값: ${spatial.median}m, 95백분위: ${spatial.p95}m, 최대 오차: ${spatial.max}m`);
    console.log(`      - 10m 초과율: ${spatial.over10mRatio}%, 20m 초과율: ${spatial.over20mRatio}%, 50m 초과율: ${spatial.over50mRatio}%`);

    // Optional: Compare with Reference Ground Truth if available (Incheon)
    let refComparison = null;
    if (testCase.referencePath && fs.existsSync(testCase.referencePath)) {
      const refXml = fs.readFileSync(testCase.referencePath, 'utf8');
      const refPts = validator.parseGPX(refXml);
      console.log(`      검증된 도로 중심선 기준선(${refPts.length} pts)과의 정밀 비교...`);
      const refSpatial = validator.evaluateSpatialErrors(matchResult.matchedPoints, refPts);
      refComparison = {
        refPointCount: refPts.length,
        meanToRefM: refSpatial.mean,
        medianToRefM: refSpatial.median,
        p95ToRefM: refSpatial.p95,
        maxToRefM: refSpatial.max
      };
      console.log(`      - 기준선 대비 평균 편차: ${refSpatial.mean}m, 95백분위: ${refSpatial.p95}m`);
    }

    // Step 3: Chunk Boundaries & U-turns
    console.log(`      청크 경계 연속성 및 U턴 무결성 분석 중...`);
    const boundary = validator.evaluateChunkBoundaries(matchResult, origPoints);
    console.log(`      - 청크 경계 수: ${boundary.boundaryCount}, 최대 연결 점프: ${boundary.maxBoundaryJumpM}m, 최대 방향 각도 변화: ${boundary.maxAngleChangeDeg}°`);
    console.log(`      - 10m 초과 점프: ${boundary.jumpOver10mCount}회, 탐지된 U턴 지점: ${boundary.uturnsDetected}곳`);

    // Step 4: Distance Axis & 1km bins
    console.log(`      거리축 변화율 (1km 단위 누적) 분석 중...`);
    const distAxis = validator.evaluateDistanceAxis(origPoints, matchResult.matchedPoints);
    console.log(`      - 원본 총거리: ${(distAxis.origTotalDistM / 1000).toFixed(2)}km -> 매칭 총거리: ${(distAxis.matchedTotalDistM / 1000).toFixed(2)}km (차이: ${distAxis.deltaDistM}m, ${distAxis.deltaRatioPercent}%)`);
    if (distAxis.hotspots.length > 0) {
      console.log(`      - 상위 거리 변화 구간:`);
      distAxis.hotspots.forEach((h, hi) => {
        console.log(`        ${hi + 1}. [${h.interval}] ${h.deltaM >= 0 ? '+' : ''}${h.deltaM}m (${h.deltaPercent}%)`);
      });
    }

    // Step 5: Elevation Profile & Shared Elevation Engine D+/D-
    console.log(`      고도 프로파일 및 RunRuun Shared Elevation Engine D+/D- 검증 중...`);
    const elevation = validator.evaluateElevationProfile(origPoints, matchResult.matchedPoints);
    console.log(`      - 평균 고도 편차: ${elevation.meanEleDiffM}m, 최대 편차: ${elevation.maxEleDiffM}m`);
    console.log(`      - 원본 D+: ${elevation.origElevation.gain}m, D-: ${elevation.origElevation.loss}m`);
    console.log(`      - 매칭 D+: ${elevation.matchedElevation.gain}m, D-: ${elevation.matchedElevation.loss}m (D+ 오차: ${elevation.gainDiffM}m, ${elevation.gainDiffPercent}%)`);

    // Step 6: Metadata Preservation
    const metadata = validator.evaluateMetadataPreservation(origPoints, matchResult.matchedPoints);
    console.log(`      - 세그먼트 보존: ${metadata.segsPreserved} (${metadata.origSegmentCount} -> ${metadata.matchedSegmentCount} segs)`);
    console.log(`      - 타임스탬프 보존: ${metadata.timePreserved}`);

    // Step 7: Anomalies & Verdict
    const anomalies = validator.detectAndCategorizeAnomalies(origPoints, matchResult.matchedPoints, spatial, boundary, distAxis);
    const verdict = validator.determineVerdict(spatial, boundary, distAxis, elevation, metadata, testCase.name);

    console.log(`      --------------------------------------------------------`);
    console.log(`      >>> 최종 판정: [ ${verdict.status} ] <<<`);
    if (verdict.issues.length > 0) {
      console.log(`      주의/이슈 항목:`);
      verdict.issues.forEach(iss => console.log(`      - ${iss}`));
    }
    console.log(`      --------------------------------------------------------`);

    // Sample coordinates for HTML visualization
    const stepSize = Math.max(1, Math.floor(origPoints.length / 800));
    const origSample = origPoints.filter((_, i) => i % stepSize === 0).map(p => [p.lat, p.lon, p.ele]);
    const mStepSize = Math.max(1, Math.floor(matchResult.matchedPoints.length / 800));
    const matchedSample = matchResult.matchedPoints.filter((_, i) => i % mStepSize === 0).map(p => [p.lat, p.lon, p.ele]);

    allResults.push({
      testCase,
      matchTimeMs,
      pointCount: {
        orig: origPoints.length,
        matched: matchResult.matchedPoints.length
      },
      spatial,
      refComparison,
      boundary: {
        boundaryCount: boundary.boundaryCount,
        maxBoundaryJumpM: boundary.maxBoundaryJumpM,
        maxAngleChangeDeg: boundary.maxAngleChangeDeg,
        jumpOver10mCount: boundary.jumpOver10mCount,
        uturnsDetected: boundary.uturnsDetected,
        uturnPoints: boundary.uturnPoints,
        boundariesSample: boundary.boundaries.filter(b => b.isJumpAnomaly || b.isAngleAnomaly || b.chunkIndex % 5 === 0)
      },
      distAxis: {
        origTotalDistM: distAxis.origTotalDistM,
        matchedTotalDistM: distAxis.matchedTotalDistM,
        deltaDistM: distAxis.deltaDistM,
        deltaRatioPercent: distAxis.deltaRatioPercent,
        hotspots: distAxis.hotspots,
        binsSample: distAxis.bins
      },
      elevation,
      metadata,
      anomalies,
      verdict,
      samples: {
        origCoords: origSample,
        matchedCoords: matchedSample
      }
    });
  }

  // Save all results to JSON
  const outPath = path.resolve(__dirname, 'accuracy_verification_results.json');
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2), 'utf8');
  console.log(`\n\n전체 6개 GPX 실측 정확도 검증 완료! 결과 저장: ${outPath}`);
}

runTestSuite().catch(e => {
  console.error('검증 실행 중 치명적 오류 발생:', e);
  process.exit(1);
});
