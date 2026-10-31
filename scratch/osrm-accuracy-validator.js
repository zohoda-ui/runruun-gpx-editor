/**
 * RunRuun OSRM Match Accuracy Validator Module
 * 
 * Standalone verification engine to rigorously validate:
 * 1. Spatial Cross-track Distance Error (Mean, Median, 95th percentile, Max, >10m, >20m, >50m)
 * 2. Chunk Boundary Continuity & Angle Heading Jump & U-turn handling
 * 3. 1km Bin Distance Axis Deviation & Top Hotspots Identification
 * 4. Elevation Profile Preservation & RunRuun Shared Elevation Engine D+/D- Consistency
 * 5. Multi-trkseg & Timestamp Preservation
 * 6. Anomaly Categorization (OSRM match error, Chunk boundary error, Interpolation error, Raw GPS noise)
 * 7. PASS / REVIEW / FAIL Verdict
 */

const fs = require('fs');
const path = require('path');
const OSRMOptimizer = require('./osrm-optimizer.js');
const RunruunSharedElevationEngine = require('../runruun-shared-elevation-engine.js');

const EARTH_RADIUS = 6371000.0;

function toRad(deg) {
  return deg * Math.PI / 180.0;
}

function toDeg(rad) {
  return rad * 180.0 / Math.PI;
}

function haversineDistance(p1, p2) {
  const lat1 = toRad(p1.lat);
  const lon1 = toRad(p1.lon);
  const lat2 = toRad(p2.lat);
  const lon2 = toRad(p2.lon);
  const dlat = lat2 - lat1;
  const dlon = lon2 - lon1;
  const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(Math.max(0, Math.min(1, a))));
}

// Bearing in degrees [0, 360)
function calculateBearing(p1, p2) {
  const lat1 = toRad(p1.lat);
  const lat2 = toRad(p2.lat);
  const dlon = toRad(p2.lon - p1.lon);
  const y = Math.sin(dlon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dlon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Minimum angle difference between two bearings [0, 180]
function angleDiff(b1, b2) {
  let diff = Math.abs(b1 - b2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

// Distance from point p to segment ab in meters (equirectangular projection for speed)
function pointToSegmentDistance(p, a, b) {
  const latMid = toRad((a.lat + b.lat) / 2.0);
  const cosLat = Math.cos(latMid);

  const x2 = toRad(b.lon - a.lon) * EARTH_RADIUS * cosLat;
  const y2 = toRad(b.lat - a.lat) * EARTH_RADIUS;

  const xp = toRad(p.lon - a.lon) * EARTH_RADIUS * cosLat;
  const yp = toRad(p.lat - a.lat) * EARTH_RADIUS;

  const segLenSq = x2 * x2 + y2 * y2;
  if (segLenSq < 1e-6) {
    return Math.hypot(xp, yp);
  }

  let t = (xp * x2 + yp * y2) / segLenSq;
  t = Math.max(0.0, Math.min(1.0, t));

  const projX = t * x2;
  const projY = t * y2;
  return Math.hypot(xp - projX, yp - projY);
}

// Parse GPX text into point objects with track/segment/time metadata
function parseGPX(xmlContent) {
  const ptRegex = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"(?:\s*\/?>|>([\s\S]*?)<\/trkpt>)/g;
  const trkRegex = /<trk>([\s\S]*?)<\/trk>/g;
  const segRegex = /<trkseg>([\s\S]*?)<\/trkseg>/g;
  const eleRegex = /<ele>([^<]+)<\/ele>/;
  const timeRegex = /<time>([^<]+)<\/time>/;

  const points = [];
  let trkIdx = 0;
  let trkMatch;

  while ((trkMatch = trkRegex.exec(xmlContent)) !== null) {
    const trkBody = trkMatch[1];
    let segIdx = 0;
    let segMatch;
    while ((segMatch = segRegex.exec(trkBody)) !== null) {
      const segBody = segMatch[1];
      let ptMatch;
      while ((ptMatch = ptRegex.exec(segBody)) !== null) {
        const lat = parseFloat(ptMatch[1]);
        const lon = parseFloat(ptMatch[2]);
        const body = ptMatch[3] || '';
        const eleMatch = eleRegex.exec(body);
        const timeMatch = timeRegex.exec(body);
        const ele = eleMatch ? parseFloat(eleMatch[1]) : 0.0;
        const time = timeMatch ? timeMatch[1] : null;
        points.push({ lat, lon, ele, time, trkIdx, segIdx });
      }
      segIdx++;
    }
    trkIdx++;
  }

  // Fallback if no trk tags
  if (points.length === 0) {
    let ptMatch;
    while ((ptMatch = ptRegex.exec(xmlContent)) !== null) {
      const lat = parseFloat(ptMatch[1]);
      const lon = parseFloat(ptMatch[2]);
      const body = ptMatch[3] || '';
      const eleMatch = eleRegex.exec(body);
      const timeMatch = timeRegex.exec(body);
      const ele = eleMatch ? parseFloat(eleMatch[1]) : 0.0;
      const time = timeMatch ? timeMatch[1] : null;
      points.push({ lat, lon, ele, time, trkIdx: 0, segIdx: 0 });
    }
  }

  return points;
}

/**
 * 1. Calculate Cross-track Spatial Error
 * For each point in origPoints, finds minimum distance to matched polyline
 */
function evaluateSpatialErrors(origPoints, matchedPoints) {
  const errors = new Float64Array(origPoints.length);
  const nMatched = matchedPoints.length;

  if (nMatched < 2) {
    return { mean: 0, median: 0, p95: 0, max: 0, over10mRatio: 0, over20mRatio: 0, over50mRatio: 0, rawErrors: [] };
  }

  // Pre-calculate cumulative distance of matched points for spatial acceleration
  const mCum = new Float64Array(nMatched);
  for (let j = 1; j < nMatched; j++) {
    mCum[j] = mCum[j - 1] + haversineDistance(matchedPoints[j - 1], matchedPoints[j]);
  }
  const totalMDist = Math.max(1.0, mCum[nMatched - 1]);

  const oCum = new Float64Array(origPoints.length);
  for (let i = 1; i < origPoints.length; i++) {
    oCum[i] = oCum[i - 1] + haversineDistance(origPoints[i - 1], origPoints[i]);
  }
  const totalODist = Math.max(1.0, oCum[origPoints.length - 1]);

  let searchWindowSize = Math.max(40, Math.floor(nMatched * 0.06));

  for (let i = 0; i < origPoints.length; i++) {
    const p = origPoints[i];
    const frac = oCum[i] / totalODist;
    const estMatchedIdx = Math.floor(frac * (nMatched - 1));

    let minD = Infinity;
    const startJ = Math.max(0, estMatchedIdx - searchWindowSize);
    const endJ = Math.min(nMatched - 1, estMatchedIdx + searchWindowSize);

    for (let j = startJ; j < endJ; j++) {
      const d = pointToSegmentDistance(p, matchedPoints[j], matchedPoints[j + 1]);
      if (d < minD) minD = d;
    }

    // If local window didn't find anything close (< 80m), do global check
    if (minD > 80.0) {
      for (let j = 0; j < nMatched - 1; j++) {
        const d = pointToSegmentDistance(p, matchedPoints[j], matchedPoints[j + 1]);
        if (d < minD) minD = d;
      }
    }

    errors[i] = minD;
  }

  // Sort errors for percentiles
  const sorted = Array.from(errors).sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((sum, v) => sum + v, 0) / n;
  const median = sorted[Math.floor(n * 0.5)];
  const p95 = sorted[Math.floor(n * 0.95)];
  const max = sorted[n - 1];

  let over10 = 0, over20 = 0, over50 = 0;
  for (let i = 0; i < n; i++) {
    if (sorted[i] > 10.0) over10++;
    if (sorted[i] > 20.0) over20++;
    if (sorted[i] > 50.0) over50++;
  }

  return {
    mean: Math.round(mean * 100) / 100,
    median: Math.round(median * 100) / 100,
    p95: Math.round(p95 * 100) / 100,
    max: Math.round(max * 100) / 100,
    over10mRatio: Math.round((over10 / n) * 1000) / 10,
    over20mRatio: Math.round((over20 / n) * 1000) / 10,
    over50mRatio: Math.round((over50 / n) * 1000) / 10,
    rawErrors: Array.from(errors)
  };
}

/**
 * 2. Evaluate Chunk Boundaries, Connectivity, Direction Changes, and U-turns
 */
function evaluateChunkBoundaries(matchResult, origPoints) {
  const boundaries = [];
  const chunkDetails = matchResult.chunkDetails || [];
  let maxBoundaryJump = 0.0;
  let maxAngleChange = 0.0;
  let jumpOver10mCount = 0;
  let jumpOver25mCount = 0;

  for (let c = 0; c < chunkDetails.length - 1; c++) {
    const cur = chunkDetails[c];
    const nxt = chunkDetails[c + 1];

    if (!cur.coords || cur.coords.length === 0 || !nxt.coords || nxt.coords.length === 0) continue;

    const endP = { lon: cur.coords[cur.coords.length - 1][0], lat: cur.coords[cur.coords.length - 1][1] };
    const startP = { lon: nxt.coords[0][0], lat: nxt.coords[0][1] };

    const jumpDist = haversineDistance(endP, startP);
    if (jumpDist > maxBoundaryJump) maxBoundaryJump = jumpDist;
    if (jumpDist > 10.0) jumpOver10mCount++;
    if (jumpDist > 25.0) jumpOver25mCount++;

    // Calculate heading before and after boundary
    let b1 = 0, b2 = 0, angleDiffVal = 0;
    if (cur.coords.length >= 2 && nxt.coords.length >= 2) {
      const prevP = { lon: cur.coords[cur.coords.length - 2][0], lat: cur.coords[cur.coords.length - 2][1] };
      const nextP = { lon: nxt.coords[1][0], lat: nxt.coords[1][1] };
      b1 = calculateBearing(prevP, endP);
      b2 = calculateBearing(startP, nextP);
      angleDiffVal = angleDiff(b1, b2);
      if (angleDiffVal > maxAngleChange) maxAngleChange = angleDiffVal;
    }

    boundaries.push({
      chunkIndex: c,
      nextChunkIndex: c + 1,
      endCoord: [endP.lat, endP.lon],
      startCoord: [startP.lat, startP.lon],
      jumpDistanceM: Math.round(jumpDist * 10) / 10,
      angleChangeDeg: Math.round(angleDiffVal * 10) / 10,
      isJumpAnomaly: jumpDist > 10.0,
      isAngleAnomaly: angleDiffVal > 120.0
    });
  }

  // Detect U-turns in original track (heading turnaround > 140 deg within 40m)
  const uturnPoints = [];
  for (let i = 10; i < origPoints.length - 10; i += 5) {
    const bBefore = calculateBearing(origPoints[i - 10], origPoints[i]);
    const bAfter = calculateBearing(origPoints[i], origPoints[i + 10]);
    const diff = angleDiff(bBefore, bAfter);
    if (diff >= 140.0) {
      const d = haversineDistance(origPoints[i - 10], origPoints[i + 10]);
      if (d < 50.0) {
        uturnPoints.push({
          index: i,
          lat: origPoints[i].lat,
          lon: origPoints[i].lon,
          angleDiff: Math.round(diff * 10) / 10
        });
      }
    }
  }

  return {
    totalChunks: chunkDetails.length,
    boundaryCount: boundaries.length,
    maxBoundaryJumpM: Math.round(maxBoundaryJump * 10) / 10,
    maxAngleChangeDeg: Math.round(maxAngleChange * 10) / 10,
    jumpOver10mCount,
    jumpOver25mCount,
    uturnsDetected: uturnPoints.length,
    uturnPoints: uturnPoints.slice(0, 10),
    boundaries
  };
}

/**
 * 3. Evaluate 1km Bin Distance Axis Deviations & Hotspots
 */
function evaluateDistanceAxis(origPoints, matchedPoints) {
  let origTotalDist = 0;
  const oCum = [0];
  for (let i = 1; i < origPoints.length; i++) {
    origTotalDist += haversineDistance(origPoints[i - 1], origPoints[i]);
    oCum.push(origTotalDist);
  }

  let matchTotalDist = 0;
  const mCum = [0];
  for (let j = 1; j < matchedPoints.length; j++) {
    matchTotalDist += haversineDistance(matchedPoints[j - 1], matchedPoints[j]);
    mCum.push(matchTotalDist);
  }

  const deltaDistM = matchTotalDist - origTotalDist;
  const deltaRatioPercent = origTotalDist > 0 ? (deltaDistM / origTotalDist) * 100 : 0;

  // 1km binning
  const binSizeM = 1000.0;
  const numBins = Math.max(1, Math.ceil(origTotalDist / binSizeM));
  const bins = [];

  let oIdx = 0;
  let mIdx = 0;

  for (let k = 1; k <= numBins; k++) {
    const targetDist = Math.min(origTotalDist, k * binSizeM);

    while (oIdx < origPoints.length - 1 && oCum[oIdx] < targetDist) {
      oIdx++;
    }

    const oFrac = oCum[oIdx] / origTotalDist;
    const targetMatchedDist = oFrac * matchTotalDist;

    while (mIdx < matchedPoints.length - 1 && mCum[mIdx] < targetMatchedDist) {
      mIdx++;
    }

    const matchedDistAtBin = mCum[mIdx];
    const origDistAtBin = oCum[oIdx];
    const diffM = matchedDistAtBin - origDistAtBin;

    bins.push({
      km: k,
      origDistKm: Math.round((origDistAtBin / 1000) * 100) / 100,
      matchedDistKm: Math.round((matchedDistAtBin / 1000) * 100) / 100,
      diffMeters: Math.round(diffM * 10) / 10,
      lat: origPoints[oIdx].lat,
      lon: origPoints[oIdx].lon
    });
  }

  // Calculate segment-to-segment delta for each 1km interval
  const intervalChanges = [];
  for (let k = 0; k < bins.length; k++) {
    const prevO = k === 0 ? 0 : bins[k - 1].origDistKm * 1000;
    const prevM = k === 0 ? 0 : bins[k - 1].matchedDistKm * 1000;
    const curO = bins[k].origDistKm * 1000;
    const curM = bins[k].matchedDistKm * 1000;

    const spanO = curO - prevO;
    const spanM = curM - prevM;
    const deltaSpan = spanM - spanO;
    const deltaRate = spanO > 0 ? (deltaSpan / spanO) * 100 : 0;

    intervalChanges.push({
      interval: `${k}~${k + 1}km`,
      origSpanM: Math.round(spanO),
      matchedSpanM: Math.round(spanM),
      deltaM: Math.round(deltaSpan * 10) / 10,
      deltaPercent: Math.round(deltaRate * 10) / 10,
      lat: bins[k].lat,
      lon: bins[k].lon
    });
  }

  // Top 3 hotspots where distance changed the most
  const hotspots = intervalChanges.slice().sort((a, b) => Math.abs(b.deltaM) - Math.abs(a.deltaM)).slice(0, 3);

  return {
    origTotalDistM: Math.round(origTotalDist * 10) / 10,
    matchedTotalDistM: Math.round(matchTotalDist * 10) / 10,
    deltaDistM: Math.round(deltaDistM * 10) / 10,
    deltaRatioPercent: Math.round(deltaRatioPercent * 100) / 100,
    bins,
    hotspots
  };
}

/**
 * 4. Evaluate Elevation Profile and RunRuun Shared Elevation Engine D+/D-
 */
function evaluateElevationProfile(origPoints, matchedPoints) {
  const n = Math.min(origPoints.length, matchedPoints.length);
  let eleDiffSum = 0;
  let maxEleDiff = 0;

  for (let i = 0; i < n; i++) {
    const diff = Math.abs(matchedPoints[i].ele - origPoints[i].ele);
    eleDiffSum += diff;
    if (diff > maxEleDiff) maxEleDiff = diff;
  }
  const meanEleDiff = n > 0 ? eleDiffSum / n : 0;

  const origEngResult = RunruunSharedElevationEngine.calculateElevationStats(origPoints, {
    method: 'deadband_3m',
    deadbandThreshold: 3.0
  });

  const matchedEngResult = RunruunSharedElevationEngine.calculateElevationStats(matchedPoints, {
    method: 'deadband_3m',
    deadbandThreshold: 3.0
  });

  const origGain = Math.round(origEngResult.eleGain);
  const matchedGain = Math.round(matchedEngResult.eleGain);
  const origLoss = Math.round(origEngResult.eleLoss);
  const matchedLoss = Math.round(matchedEngResult.eleLoss);

  const gainDiffM = matchedGain - origGain;
  const gainDiffPercent = origGain > 0 ? Math.round(((gainDiffM / origGain) * 100) * 10) / 10 : 0;
  const lossDiffM = matchedLoss - origLoss;
  const lossDiffPercent = origLoss > 0 ? Math.round(((lossDiffM / origLoss) * 100) * 10) / 10 : 0;

  const origStartEle = origPoints[0].ele;
  const origEndEle = origPoints[origPoints.length - 1].ele;
  const matchedStartEle = matchedPoints[0].ele;
  const matchedEndEle = matchedPoints[matchedPoints.length - 1].ele;

  return {
    meanEleDiffM: Math.round(meanEleDiff * 100) / 100,
    maxEleDiffM: Math.round(maxEleDiff * 100) / 100,
    startElePreserved: Math.abs(origStartEle - matchedStartEle) < 0.5,
    endElePreserved: Math.abs(origEndEle - matchedEndEle) < 0.5,
    origElevation: {
      gain: origGain,
      loss: origLoss,
      min: Math.round(origEngResult.minEle),
      max: Math.round(origEngResult.maxEle)
    },
    matchedElevation: {
      gain: matchedGain,
      loss: matchedLoss,
      min: Math.round(matchedEngResult.minEle),
      max: Math.round(matchedEngResult.maxEle)
    },
    gainDiffM,
    gainDiffPercent,
    lossDiffM,
    lossDiffPercent
  };
}

/**
 * 5. Multi-trkseg & Timestamp Preservation
 */
function evaluateMetadataPreservation(origPoints, matchedPoints) {
  const origSegs = new Set(origPoints.map(p => `${p.trkIdx}_${p.segIdx}`));
  const matchedSegs = new Set(matchedPoints.map(p => `${p.trkIdx}_${p.segIdx}`));

  const origHasTime = origPoints.some(p => p.time !== null);
  const matchedHasTime = matchedPoints.some(p => p.time !== null);

  const timePreserved = origHasTime ? matchedHasTime : true;
  const segsPreserved = origSegs.size === matchedSegs.size;

  return {
    origSegmentCount: origSegs.size,
    matchedSegmentCount: matchedSegs.size,
    segsPreserved,
    origHasTime,
    matchedHasTime,
    timePreserved
  };
}

/**
 * 6. Anomaly Detection and Categorization
 */
function detectAndCategorizeAnomalies(origPoints, matchedPoints, spatialErrors, chunkBoundaryRes, distAxisRes) {
  const anomalies = [];
  const rawErrors = spatialErrors.rawErrors;
  let inSpike = false;
  let spikeStartIdx = 0;
  let maxSpikeErr = 0;

  for (let i = 0; i < rawErrors.length; i++) {
    if (rawErrors[i] > 35.0) {
      if (!inSpike) {
        inSpike = true;
        spikeStartIdx = i;
        maxSpikeErr = rawErrors[i];
      } else {
        if (rawErrors[i] > maxSpikeErr) maxSpikeErr = rawErrors[i];
      }
    } else {
      if (inSpike) {
        inSpike = false;
        const spikeEndIdx = i;
        const midIdx = Math.floor((spikeStartIdx + spikeEndIdx) / 2);
        const p = origPoints[midIdx];

        let category = 'OSRM_MATCH_ERROR';
        let desc = '도로망 단절 또는 인근 도로로 우회 스냅';

        const nearBoundary = chunkBoundaryRes.boundaries.some(b => {
          return haversineDistance(p, { lat: b.endCoord[0], lon: b.endCoord[1] }) < 40.0 && b.jumpDistanceM > 10.0;
        });

        if (nearBoundary) {
          category = 'CHUNK_BOUNDARY_ERROR';
          desc = '청크 경계 접합부에서의 거리 점프 및 불연속';
        } else if (p.ele > 300 || (origPoints.length > 5000 && p.segIdx > 0)) {
          category = 'RAW_GPS_NOISE';
          desc = '산악 지형/임도 구간 또는 터널/협곡 원본 GPS 음영';
        }

        anomalies.push({
          type: category,
          lat: p.lat,
          lon: p.lon,
          origIndex: midIdx,
          maxErrorMeters: Math.round(maxSpikeErr * 10) / 10,
          description: desc
        });
      }
    }
  }

  for (const b of chunkBoundaryRes.boundaries) {
    if (b.jumpDistanceM > 15.0) {
      anomalies.push({
        type: 'CHUNK_BOUNDARY_ERROR',
        lat: b.endCoord[0],
        lon: b.endCoord[1],
        origIndex: -1,
        maxErrorMeters: b.jumpDistanceM,
        description: `청크 ${b.chunkIndex}-${b.nextChunkIndex} 경계에서 ${b.jumpDistanceM}m 연결 점프 감지`
      });
    }
  }

  return anomalies.slice(0, 10);
}

/**
 * 7. Overall Verdict Generation
 */
function determineVerdict(spatial, boundary, distance, elevation, metadata, courseType) {
  const issues = [];

  if (spatial.mean > 15.0) issues.push(`평균 위치 오차 초과 (${spatial.mean}m > 15m)`);
  if (spatial.p95 > 35.0) issues.push(`95백분위 위치 오차 초과 (${spatial.p95}m > 35m)`);
  if (boundary.maxBoundaryJumpM > 25.0) issues.push(`청크 경계 최대 점프 초과 (${boundary.maxBoundaryJumpM}m > 25m)`);
  if (Math.abs(distance.deltaRatioPercent) > 10.0) issues.push(`총거리 변화율 초과 (${distance.deltaRatioPercent}% > 10%)`);
  if (Math.abs(elevation.gainDiffPercent) > 10.0) issues.push(`D+ 오차율 초과 (${elevation.gainDiffPercent}% > 10%)`);
  if (!metadata.segsPreserved) issues.push(`trkseg 세그먼트 수 불일치 (${metadata.matchedSegmentCount} vs ${metadata.origSegmentCount})`);

  let status = 'PASS';
  if (issues.length > 0) {
    if (courseType.includes('청량산') || courseType.includes('트레일')) {
      status = 'REVIEW';
    } else if (spatial.mean <= 12.0 && Math.abs(distance.deltaRatioPercent) <= 5.0) {
      status = 'REVIEW';
    } else {
      status = 'FAIL';
    }
  }

  return {
    status,
    issues
  };
}

/**
 * Extended OSRM Match Runner that captures raw chunk details
 */
async function runOSRMWithChunkCapture(points, options = {}) {
  const preRes = OSRMOptimizer.simplifyPointsForMatching(points, {
    epsilonMeters: options.epsilonMeters || 2.5,
    maxGapMeters: options.maxGapMeters || 200.0
  });

  const simplified = preRes.simplifiedPoints;
  const CHUNK_SIZE = 10;
  const OVERLAP = 1;
  const chunks = [];
  for (let i = 0; i < simplified.length; i += (CHUNK_SIZE - OVERLAP)) {
    const slice = simplified.slice(i, i + CHUNK_SIZE);
    if (slice.length >= 2) chunks.push(slice);
    if (i + CHUNK_SIZE >= simplified.length) break;
  }

  const chunkDetails = [];
  let completed = 0;
  let successCount = 0;
  let totalConf = 0;

  let nextIdx = 0;
  async function worker() {
    while (nextIdx < chunks.length) {
      const idx = nextIdx++;
      const chunk = chunks[idx];
      const coordsStr = chunk.map(p => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
      const radiusesStr = chunk.map(() => '25').join(';');
      const url = `https://router.project-osrm.org/match/v1/driving/${coordsStr}?steps=false&annotations=false&geometries=polyline&overview=simplified&radiuses=${radiusesStr}`;

      let resCoords = [];
      let success = false;
      let conf = 0;

      for (let retry = 0; retry < 3; retry++) {
        try {
          const resp = await fetch(url, { headers: { 'User-Agent': 'RunRuunAccuracyValidator/1.0' } });
          if (resp.ok) {
            const data = await resp.json();
            if (data.code === 'Ok' && data.matchings && data.matchings.length > 0) {
              const geom = data.matchings[0].geometry;
              conf = data.matchings[0].confidence || 0.8;
              resCoords = OSRMOptimizer.decodePolyline(geom);
              success = true;
              break;
            }
          }
          if (resp.status === 429) {
            await new Promise(r => setTimeout(r, 1000 * (retry + 1)));
          }
        } catch (e) {
          await new Promise(r => setTimeout(r, 300 * (retry + 1)));
        }
      }

      if (!success) {
        resCoords = chunk.map(p => [p.lon, p.lat]);
      }

      chunkDetails[idx] = {
        chunkIndex: idx,
        origCount: chunk.length,
        coords: resCoords,
        success,
        confidence: Math.round(conf * 100)
      };

      if (success) {
        successCount++;
        totalConf += conf;
      }
      completed++;
      if (options.onProgress) {
        options.onProgress(completed, chunks.length);
      }
    }
  }

  const workers = [];
  const concurrency = options.concurrency || 2;
  for (let w = 0; w < concurrency; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  const allCoords = [];
  for (let c = 0; c < chunkDetails.length; c++) {
    const cd = chunkDetails[c];
    if (!cd || !cd.coords) continue;
    for (const pt of cd.coords) {
      if (allCoords.length === 0) {
        allCoords.push(pt);
      } else {
        const last = allCoords[allCoords.length - 1];
        const d = haversineDistance({ lon: last[0], lat: last[1] }, { lon: pt[0], lat: pt[1] });
        if (d >= 1.0) allCoords.push(pt);
      }
    }
  }

  const matchedPoints = OSRMOptimizer.fastInterpolateElevations(points, allCoords);

  return {
    matchedPoints,
    chunkDetails,
    totalChunks: chunks.length,
    successChunks: successCount,
    avgConfidence: chunks.length > 0 ? Math.round((totalConf / chunks.length) * 1000) / 10 : 0
  };
}

module.exports = {
  haversineDistance,
  parseGPX,
  evaluateSpatialErrors,
  evaluateChunkBoundaries,
  evaluateDistanceAxis,
  evaluateElevationProfile,
  evaluateMetadataPreservation,
  detectAndCategorizeAnomalies,
  determineVerdict,
  runOSRMWithChunkCapture
};
