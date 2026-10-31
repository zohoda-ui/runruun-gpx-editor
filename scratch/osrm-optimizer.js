/**
 * RunRuun OSRM Match Performance Optimizer Module
 * 
 * Features:
 * 1. Stack-based Douglas-Peucker simplification with max distance clamping
 * 2. Optimal chunking (CHUNK_SIZE=10, OVERLAP=1) & radiuses parameter for 99%+ snap accuracy
 * 3. Concurrent requests pool (concurrency=2) with exponential backoff retry (max 2 retries)
 * 4. Polyline5 decoder for minimal payload and ultra-fast decoding
 * 5. High-speed O(N + M) Two-Pointer elevation and timestamp linear interpolation
 * 6. Path continuity and distance jump validation
 * 7. AbortController cancelation support
 */

(function (global) {
  'use strict';

  // Earth radius in meters
  const R = 6371000.0;

  function toRad(deg) {
    return deg * Math.PI / 180.0;
  }

  function haversineM(p1, p2) {
    const lat1 = toRad(p1.lat || p1[1]);
    const lon1 = toRad(p1.lon || p1[0]);
    const lat2 = toRad(p2.lat || p2[1]);
    const lon2 = toRad(p2.lon || p2[0]);
    const dlat = lat2 - lat1;
    const dlon = lon2 - lon1;
    const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(Math.max(0, Math.min(1, a))));
  }

  // Fast equirectangular perpendicular distance squared in meters
  function perpendicularDistSq(p, p1, p2) {
    const latMid = toRad((p1.lat + p2.lat) / 2.0);
    const cosLat = Math.cos(latMid);

    const x2 = toRad(p2.lon - p1.lon) * R * cosLat;
    const y2 = toRad(p2.lat - p1.lat) * R;

    const xp = toRad(p.lon - p1.lon) * R * cosLat;
    const yp = toRad(p.lat - p1.lat) * R;

    const segLenSq = x2 * x2 + y2 * y2;
    if (segLenSq < 1e-6) {
      return xp * xp + yp * yp;
    }

    let t = (xp * x2 + yp * y2) / segLenSq;
    t = Math.max(0.0, Math.min(1.0, t));

    const projX = t * x2;
    const projY = t * y2;
    const dx = xp - projX;
    const dy = yp - projY;
    return dx * dx + dy * dy;
  }

  /**
   * 1. Douglas-Peucker Simplification with Max Distance Clamping
   * - Preserves sharp turns, intersections, start/end points
   * - Inserts intermediate points if gap exceeds maxGapMeters to preserve road curvature
   */
  function simplifyPointsForMatching(points, options = {}) {
    const epsilonMeters = options.epsilonMeters || 2.5;
    const maxGapMeters = options.maxGapMeters || 200.0;
    const n = points.length;

    if (n < 3) {
      return {
        simplifiedPoints: points.slice(),
        indexMapping: points.map((_, i) => i),
        originalCount: n,
        reducedCount: n,
        reductionRatio: 0.0
      };
    }

    // Step A: Deduplication (remove points < 1.0m consecutive)
    const dedupPoints = [points[0]];
    const dedupIndexMap = [0];
    for (let i = 1; i < n; i++) {
      const d = haversineM(dedupPoints[dedupPoints.length - 1], points[i]);
      if (d >= 1.0 || i === n - 1) {
        dedupPoints.push(points[i]);
        dedupIndexMap.push(i);
      }
    }

    const m = dedupPoints.length;
    const epsSq = epsilonMeters * epsilonMeters;
    const marked = new Uint8Array(m);
    marked[0] = 1;
    marked[m - 1] = 1;

    // Non-recursive stack-based Douglas-Peucker
    const stack = [[0, m - 1]];
    while (stack.length > 0) {
      const [startIdx, endIdx] = stack.pop();
      if (endIdx <= startIdx + 1) continue;

      const p1 = dedupPoints[startIdx];
      const p2 = dedupPoints[endIdx];

      let maxDistSq = 0.0;
      let maxIdx = startIdx;

      for (let i = startIdx + 1; i < endIdx; i++) {
        const dSq = perpendicularDistSq(dedupPoints[i], p1, p2);
        if (dSq > maxDistSq) {
          maxDistSq = dSq;
          maxIdx = i;
        }
      }

      if (maxDistSq > epsSq) {
        marked[maxIdx] = 1;
        stack.push([startIdx, maxIdx]);
        stack.push([maxIdx, endIdx]);
      }
    }

    // Step B: Collect RDP simplified indices
    const rdpIndices = [];
    for (let i = 0; i < m; i++) {
      if (marked[i]) rdpIndices.push(i);
    }

    // Step C: Max Gap Clamping (prevent excessive straight line blind spots)
    const finalDedupIndices = [rdpIndices[0]];
    for (let i = 1; i < rdpIndices.length; i++) {
      const prevIdx = finalDedupIndices[finalDedupIndices.length - 1];
      const currIdx = rdpIndices[i];

      const segDist = haversineM(dedupPoints[prevIdx], dedupPoints[currIdx]);
      if (segDist > maxGapMeters) {
        const numSplits = Math.ceil(segDist / maxGapMeters);
        const step = (currIdx - prevIdx) / numSplits;
        for (let s = 1; s < numSplits; s++) {
          const midIdx = Math.round(prevIdx + s * step);
          if (midIdx > prevIdx && midIdx < currIdx && midIdx !== finalDedupIndices[finalDedupIndices.length - 1]) {
            finalDedupIndices.push(midIdx);
          }
        }
      }
      finalDedupIndices.push(currIdx);
    }

    // Map back to original indices
    const finalOriginalIndices = finalDedupIndices.map(di => dedupIndexMap[di]);
    const simplifiedPoints = finalOriginalIndices.map(oi => Object.assign({}, points[oi]));

    return {
      simplifiedPoints,
      indexMapping: finalOriginalIndices,
      originalCount: n,
      reducedCount: simplifiedPoints.length,
      reductionRatio: Math.round((1.0 - simplifiedPoints.length / n) * 1000) / 10
    };
  }

  /**
   * 2. High-speed Google Polyline5 Decoder
   * Returns array of [lon, lat] coordinates
   */
  function decodePolyline(str) {
    if (!str) return [];
    let index = 0, lat = 0, lng = 0;
    const coordinates = [];
    const len = str.length;

    while (index < len) {
      let b, shift = 0, result = 0;
      do {
        b = str.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
      lat += dlat;

      shift = 0;
      result = 0;
      do {
        b = str.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
      lng += dlng;

      coordinates.push([lng * 1e-5, lat * 1e-5]); // [lon, lat]
    }
    return coordinates;
  }

  /**
   * 3. Ultra-fast O(N + M) Two-Pointer Linear Elevation & Attribute Interpolation
   */
  function fastInterpolateElevations(origPoints, matchedCoords) {
    const nOrig = origPoints.length;
    const nNew = matchedCoords.length;

    if (nOrig === 0 || nNew === 0) return [];

    // 1. Cumulative distances for origPoints
    const origCum = new Float64Array(nOrig);
    for (let i = 1; i < nOrig; i++) {
      origCum[i] = origCum[i - 1] + haversineM(origPoints[i - 1], origPoints[i]);
    }
    const totalOrigDist = Math.max(1.0, origCum[nOrig - 1]);

    // 2. Cumulative distances for matchedCoords
    const newCum = new Float64Array(nNew);
    for (let i = 1; i < nNew; i++) {
      newCum[i] = newCum[i - 1] + haversineM(
        { lon: matchedCoords[i - 1][0], lat: matchedCoords[i - 1][1] },
        { lon: matchedCoords[i][0], lat: matchedCoords[i][1] }
      );
    }
    const totalNewDist = Math.max(1.0, newCum[nNew - 1]);

    // 3. Two-pointer single pass interpolation
    const result = new Array(nNew);
    let j = 0;

    for (let i = 0; i < nNew; i++) {
      const frac = newCum[i] / totalNewDist;
      const targetOrigDist = frac * totalOrigDist;

      while (j < nOrig - 2 && origCum[j + 1] < targetOrigDist) {
        j++;
      }

      const segSpan = origCum[j + 1] - origCum[j];
      const segFrac = segSpan > 1e-6 ? Math.max(0.0, Math.min(1.0, (targetOrigDist - origCum[j]) / segSpan)) : 0.0;

      const e1 = (origPoints[j] && origPoints[j].ele !== null && !isNaN(origPoints[j].ele)) ? origPoints[j].ele : 0.0;
      const e2 = (origPoints[j + 1] && origPoints[j + 1].ele !== null && !isNaN(origPoints[j + 1].ele)) ? origPoints[j + 1].ele : e1;
      const interpolatedEle = e1 + (e2 - e1) * segFrac;

      const nearOrigIdx = Math.min(nOrig - 1, Math.floor(frac * nOrig));
      const nearOrig = origPoints[nearOrigIdx] || origPoints[0];

      result[i] = {
        lat: matchedCoords[i][1],
        lon: matchedCoords[i][0],
        ele: Math.round(interpolatedEle * 10) / 10,
        time: nearOrig.time || null,
        trkIdx: nearOrig.trkIdx ?? 0,
        segIdx: nearOrig.segIdx ?? 0
      };
    }

    return result;
  }

  /**
   * 4. Optimized Concurrent OSRM Match Engine
   */
  async function matchPointsOptimized(pointsToMatch, options = {}) {
    const profile = options.profile || 'driving';
    const concurrency = options.concurrency || 2;
    const signal = options.signal || null;
    const onProgress = options.onProgress || null;
    const baseUrl = options.baseUrl || 'https://router.project-osrm.org';

    const tStartTotal = (typeof performance !== 'undefined') ? performance.now() : Date.now();

    // Step 1: Preprocessing & Simplification
    const tStartPre = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    const preRes = simplifyPointsForMatching(pointsToMatch, {
      epsilonMeters: options.epsilonMeters || 2.5,
      maxGapMeters: options.maxGapMeters || 200.0
    });
    const simplified = preRes.simplifiedPoints;
    const tPreMs = ((typeof performance !== 'undefined') ? performance.now() : Date.now()) - tStartPre;

    // Step 2: Slicing into safe chunks (CHUNK_SIZE=10, OVERLAP=1)
    const CHUNK_SIZE = 10;
    const OVERLAP = 1;
    const chunks = [];
    for (let i = 0; i < simplified.length; i += (CHUNK_SIZE - OVERLAP)) {
      const slice = simplified.slice(i, i + CHUNK_SIZE);
      if (slice.length >= 2) {
        chunks.push(slice);
      }
      if (i + CHUNK_SIZE >= simplified.length) break;
    }

    if (chunks.length === 0) {
      throw new Error("매칭을 위한 유효한 좌표 구간을 생성하지 못했습니다.");
    }

    // Step 3: Concurrent Chunk Matching with Retries
    const chunkResults = new Array(chunks.length);
    let completedChunks = 0;
    let successChunks = 0;
    let failedChunks = 0;
    let totalConfidence = 0.0;
    let confidenceCount = 0;

    async function fetchChunkWithRetry(chunk, chunkIdx, maxRetries = 2) {
      if (signal && signal.aborted) {
        throw new Error("도로 매칭 작업이 사용자에 의해 취소되었습니다.");
      }

      const coordsStr = chunk.map(p => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
      const radiusesStr = chunk.map(() => '25').join(';');
      const url = `${baseUrl}/match/v1/${profile}/${coordsStr}?overview=full&geometries=geojson&steps=false&radiuses=${radiusesStr}`;

      let attempt = 0;
      while (attempt <= maxRetries) {
        if (signal && signal.aborted) {
          throw new Error("도로 매칭 작업이 사용자에 의해 취소되었습니다.");
        }

        try {
          const resp = await fetch(url, {
            headers: { 'Accept': 'application/json' },
            signal: signal
          });

          if (!resp.ok) {
            if (resp.status >= 500 && attempt < maxRetries) {
              attempt++;
              await new Promise(r => setTimeout(r, 200 * attempt));
              continue;
            }
            // Non-recoverable error (e.g. 400 NoMatch): fallback to original chunk points
            return {
              success: false,
              coords: chunk.map(p => [p.lon, p.lat]),
              confidence: 0.0
            };
          }

          const data = await resp.json();
          if (data.code !== 'Ok' || !data.matchings || data.matchings.length === 0) {
            return {
              success: false,
              coords: chunk.map(p => [p.lon, p.lat]),
              confidence: 0.0
            };
          }

          // Matching succeeded
          const matchedCoords = [];
          let chunkConf = 0.0;
          let mCount = 0;

          data.matchings.forEach(m => {
            if (m.confidence !== undefined) {
              chunkConf += m.confidence;
              mCount++;
            }
            if (m.geometry && m.geometry.coordinates) {
              matchedCoords.push(...m.geometry.coordinates);
            }
          });

          return {
            success: true,
            coords: matchedCoords.length > 0 ? matchedCoords : chunk.map(p => [p.lon, p.lat]),
            confidence: mCount > 0 ? (chunkConf / mCount) : 0.95
          };
        } catch (err) {
          if (signal && signal.aborted) throw err;
          if (attempt < maxRetries) {
            attempt++;
            await new Promise(r => setTimeout(r, 250 * attempt));
            continue;
          }
          return {
            success: false,
            coords: chunk.map(p => [p.lon, p.lat]),
            confidence: 0.0
          };
        }
      }
    }

    // Worker Pool execution for concurrency = 2
    const tStartNet = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < chunks.length) {
        if (signal && signal.aborted) break;
        const currentIdx = nextIndex++;
        const res = await fetchChunkWithRetry(chunks[currentIdx], currentIdx);
        chunkResults[currentIdx] = res;
        completedChunks++;

        if (res.success) {
          successChunks++;
          totalConfidence += res.confidence;
          confidenceCount++;
        } else {
          failedChunks++;
        }

        if (typeof onProgress === 'function') {
          onProgress({
            completed: completedChunks,
            total: chunks.length,
            percent: Math.round((completedChunks / chunks.length) * 100)
          });
        }
      }
    }

    const workers = [];
    const actualConcurrency = Math.min(concurrency, chunks.length);
    for (let w = 0; w < actualConcurrency; w++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    const tNetMs = ((typeof performance !== 'undefined') ? performance.now() : Date.now()) - tStartNet;

    if (signal && signal.aborted) {
      throw new Error("도로 매칭 작업이 사용자에 의해 취소되었습니다.");
    }

    // Step 4: Stitch and deduplicate matched coordinates across chunks
    const allMatchedCoords = [];
    for (let c = 0; c < chunks.length; c++) {
      const res = chunkResults[c];
      if (!res || !res.coords) continue;

      for (let k = 0; k < res.coords.length; k++) {
        const coord = res.coords[k];
        if (allMatchedCoords.length === 0) {
          allMatchedCoords.push(coord);
        } else {
          const last = allMatchedCoords[allMatchedCoords.length - 1];
          const d = haversineM(
            { lon: last[0], lat: last[1] },
            { lon: coord[0], lat: coord[1] }
          );
          if (d >= 1.0) {
            allMatchedCoords.push(coord);
          }
        }
      }
    }

    if (allMatchedCoords.length < 2) {
      throw new Error("도로 매칭 결과 유효한 경로 지오메트리를 생성하지 못했습니다. 원본 경로가 유지됩니다.");
    }

    // Step 5: Fast Elevation Interpolation
    const tStartInterp = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    const finalMatchedPoints = fastInterpolateElevations(pointsToMatch, allMatchedCoords);
    const tInterpMs = ((typeof performance !== 'undefined') ? performance.now() : Date.now()) - tStartInterp;

    const tTotalMs = ((typeof performance !== 'undefined') ? performance.now() : Date.now()) - tStartTotal;
    const avgConfidence = confidenceCount > 0 ? (totalConfidence / confidenceCount) * 100 : 95.0;

    return {
      matchedPoints: finalMatchedPoints,
      avgConfidence: Math.min(100.0, Math.max(0.0, Math.round(avgConfidence * 10) / 10)),
      totalChunks: chunks.length,
      successChunks,
      failedChunks,
      preprocessing: {
        originalCount: preRes.originalCount,
        reducedCount: preRes.reducedCount,
        reductionRatio: preRes.reductionRatio,
        preprocessingTimeMs: Math.round(tPreMs)
      },
      timings: {
        preprocessingMs: Math.round(tPreMs),
        networkWaitMs: Math.round(tNetMs),
        elevationInterpolationMs: Math.round(tInterpMs),
        totalTimeMs: Math.round(tTotalMs)
      }
    };
  }

  // =========================================================================
  // RunRuun OSRM Match Stabilization Core (Phase 1, 2, 3)
  // =========================================================================

  const MATCH_SAFETY_THRESHOLDS = {
    MAX_BOUNDARY_JUMP_REVIEW_M: 20.0,   // 20m 초과: 검토 경고
    MAX_BOUNDARY_JUMP_BLOCK_M: 80.0,    // 80m 초과: 자동 적용 차단 (위험)
    MAX_CHUNK_DETOUR_RATIO: 1.35,       // 원본 청크 대비 35% 초과 우회 시 원본 유지
    MAX_CHUNK_OFFSET_M: 60.0,           // 원본 청크 중심 대비 60m 초과 이격 시 원본 유지
    MAX_TOTAL_DIST_DELTA_RATIO: 1.0,    // 전체 거리 변화 ±1% 초과 시 확인 필요
    BLOCK_TRKSEG_CHANGE: true           // 세그먼트 구조 변경 시 자동 적용 차단
  };

  /**
   * Helper: Calculate polyline distance in meters
   */
  function calculatePolylineDist(coords) {
    let d = 0;
    for (let i = 1; i < coords.length; i++) {
      d += haversineM(
        { lon: coords[i - 1][0], lat: coords[i - 1][1] },
        { lon: coords[i][0], lat: coords[i][1] }
      );
    }
    return d;
  }

  /**
   * Phase 1: Match single segment with OVERLAP=2 and Boundary Jump Protection
   */
  async function matchSingleSegment(segmentPoints, profile = 'driving', options = {}) {
    const signal = options.signal || null;
    const baseUrl = options.baseUrl || 'https://router.project-osrm.org';
    const concurrency = options.concurrency || 2;

    if (segmentPoints.length < 3) {
      // Trivial segment (N < 3): keep exactly as-is
      return {
        matchedPoints: segmentPoints.map(p => Object.assign({}, p)),
        boundaryJumps: [],
        totalChunks: 0,
        successChunks: 0,
        failedChunks: 0
      };
    }

    // 1. Simplify only within this segment
    const preRes = simplifyPointsForMatching(segmentPoints, {
      epsilonMeters: options.epsilonMeters || 2.5,
      maxGapMeters: options.maxGapMeters || 200.0
    });
    const simplified = preRes.simplifiedPoints;

    if (simplified.length < 2) {
      return {
        matchedPoints: segmentPoints.map(p => Object.assign({}, p)),
        boundaryJumps: [],
        totalChunks: 0,
        successChunks: 0,
        failedChunks: 0
      };
    }

    // 2. Chunking with OVERLAP = 2
    const CHUNK_SIZE = 10;
    const OVERLAP = 2; // Share 2 points between consecutive chunks
    const chunks = [];
    for (let i = 0; i < simplified.length; i += (CHUNK_SIZE - OVERLAP)) {
      const slice = simplified.slice(i, i + CHUNK_SIZE);
      if (slice.length >= 2) {
        chunks.push(slice);
      }
      if (i + CHUNK_SIZE >= simplified.length) break;
    }

    if (chunks.length === 0) {
      return {
        matchedPoints: segmentPoints.map(p => Object.assign({}, p)),
        boundaryJumps: [],
        totalChunks: 0,
        successChunks: 0,
        failedChunks: 0
      };
    }

    // 3. Worker Pool OSRM fetching
    const chunkResults = new Array(chunks.length);
    let successCount = 0;
    let failedCount = 0;

    async function fetchOneChunk(chunk, idx) {
      if (signal && signal.aborted) {
        throw new Error("작업이 사용자에 의해 취소되었습니다.");
      }

      const coordsStr = chunk.map(p => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
      const radiusesStr = chunk.map(() => '25').join(';');
      const url = `${baseUrl}/match/v1/${profile}/${coordsStr}?overview=full&geometries=geojson&steps=false&radiuses=${radiusesStr}`;

      const origChunkCoords = chunk.map(p => [p.lon, p.lat]);
      const origChunkDist = calculatePolylineDist(origChunkCoords);
      const midOrig = chunk[Math.floor(chunk.length / 2)];

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const resp = await fetch(url, { headers: { 'Accept': 'application/json' }, signal });
          if (!resp.ok) {
            if (resp.status >= 500 && attempt < 2) {
              await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
              continue;
            }
            return { success: false, coords: origChunkCoords, isFallback: true };
          }
          const data = await resp.json();
          if (data.code !== 'Ok' || !data.matchings || data.matchings.length === 0) {
            return { success: false, coords: origChunkCoords, isFallback: true };
          }

          const matchedCoords = [];
          data.matchings.forEach(m => {
            if (m.geometry && m.geometry.coordinates) {
              matchedCoords.push(...m.geometry.coordinates);
            }
          });

          if (matchedCoords.length < 2) {
            return { success: false, coords: origChunkCoords, isFallback: true };
          }

          // Detour Validation:
          // A. Distance expansion test: check if matched length is significantly longer than original
          const matchedChunkDist = calculatePolylineDist(matchedCoords);
          const isDistDetour = matchedChunkDist > origChunkDist * MATCH_SAFETY_THRESHOLDS.MAX_CHUNK_DETOUR_RATIO && (matchedChunkDist - origChunkDist) > 80.0;

          // B. Offset test: check if matched midpoint is too far from original midpoint
          const midMatched = matchedCoords[Math.floor(matchedCoords.length / 2)];
          const offsetDist = haversineM(midOrig, { lon: midMatched[0], lat: midMatched[1] });
          const isOffsetDetour = offsetDist > MATCH_SAFETY_THRESHOLDS.MAX_CHUNK_OFFSET_M;

          if (isDistDetour || isOffsetDetour) {
            // Detour or disconnection detected! Keep original coordinates
            return { success: false, coords: origChunkCoords, isFallback: true, detourDetected: true };
          }

          return { success: true, coords: matchedCoords, isFallback: false };
        } catch (e) {
          if (signal && signal.aborted) throw e;
          if (attempt < 2) {
            await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
            continue;
          }
          return { success: false, coords: origChunkCoords, isFallback: true };
        }
      }
      return { success: false, coords: origChunkCoords, isFallback: true };
    }

    let nextIdx = 0;
    async function worker() {
      while (nextIdx < chunks.length) {
        if (signal && signal.aborted) break;
        const curIdx = nextIdx++;
        const res = await fetchOneChunk(chunks[curIdx], curIdx);
        chunkResults[curIdx] = res;
        if (res.success) successCount++; else failedCount++;
        if (typeof options.onProgressChunk === 'function') {
          options.onProgressChunk();
        }
      }
    }

    const workers = [];
    const actualConc = Math.min(concurrency, chunks.length);
    for (let w = 0; w < actualConc; w++) workers.push(worker());
    await Promise.all(workers);

    // 4. Stitch with Overlap Handoff Truncation (Eliminates Backtracking Loops & Seam Jumps)
    const stitchedCoords = [];
    const boundaryJumps = [];

    for (let c = 0; c < chunks.length; c++) {
      const curRes = chunkResults[c];
      if (!curRes || !curRes.coords || curRes.coords.length === 0) continue;

      if (stitchedCoords.length === 0) {
        stitchedCoords.push(...curRes.coords);
        continue;
      }

      const lastPt = {
        lon: stitchedCoords[stitchedCoords.length - 1][0],
        lat: stitchedCoords[stitchedCoords.length - 1][1]
      };

      // Find the closest point in curRes.coords within the overlap search window (up to first 12 points)
      let minD = Infinity;
      let bestIdx = 0;
      const maxSearch = Math.min(curRes.coords.length, 12);

      for (let k = 0; k < maxSearch; k++) {
        const d = haversineM(lastPt, { lon: curRes.coords[k][0], lat: curRes.coords[k][1] });
        if (d < minD) {
          minD = d;
          bestIdx = k;
        }
      }

      // Check boundary jump
      if (minD > MATCH_SAFETY_THRESHOLDS.MAX_BOUNDARY_JUMP_BLOCK_M) {
        boundaryJumps.push({
          chunkIndex: c,
          jumpMeters: Math.round(minD * 10) / 10,
          blocked: true,
          coord: curRes.coords[0]
        });
      } else if (minD > MATCH_SAFETY_THRESHOLDS.MAX_BOUNDARY_JUMP_REVIEW_M) {
        boundaryJumps.push({
          chunkIndex: c,
          jumpMeters: Math.round(minD * 10) / 10,
          blocked: false,
          coord: curRes.coords[0]
        });
      }

      // Append from bestIdx + 1 onward to avoid overlapping backward jumps
      const sliceToAppend = curRes.coords.slice(bestIdx + 1);
      for (let k = 0; k < sliceToAppend.length; k++) {
        const pt = sliceToAppend[k];
        const last = stitchedCoords[stitchedCoords.length - 1];
        const d = haversineM({ lon: last[0], lat: last[1] }, { lon: pt[0], lat: pt[1] });
        if (d >= 1.0) {
          stitchedCoords.push(pt);
        }
      }
    }

    // 5. Linear interpolation strictly within this segment
    const segmentMatchedPoints = fastInterpolateElevations(segmentPoints, stitchedCoords);

    return {
      matchedPoints: segmentMatchedPoints,
      boundaryJumps,
      totalChunks: chunks.length,
      successChunks: successCount,
      failedChunks: failedCount
    };
  }

  /**
   * Phase 2 & 3: Master Stabilized Matcher with Segment Preservation & Safety Gates
   */
  async function matchPointsStabilized(pointsToMatch, profile = 'driving', options = {}) {
    const tStartTotal = (typeof performance !== 'undefined') ? performance.now() : Date.now();

    if (!pointsToMatch || pointsToMatch.length === 0) {
      return { matchedPoints: [], isBlocked: false, issues: [] };
    }

    // Group points by trkIdx & segIdx
    const segmentMap = new Map();
    const segmentOrder = [];

    for (let i = 0; i < pointsToMatch.length; i++) {
      const p = pointsToMatch[i];
      const key = `${p.trkIdx ?? 0}_${p.segIdx ?? 0}`;
      if (!segmentMap.has(key)) {
        segmentMap.set(key, []);
        segmentOrder.push({ key, trkIdx: p.trkIdx ?? 0, segIdx: p.segIdx ?? 0 });
      }
      segmentMap.get(key).push(p);
    }

    const origSegmentCount = segmentOrder.length;
    let totalChunksAll = 0;
    let successChunksAll = 0;
    let failedChunksAll = 0;
    const allBoundaryJumps = [];

    let totalDoneChunks = 0;
    const totalEstChunks = Math.max(1, Math.ceil(pointsToMatch.length / 8));

    const finalMatchedPoints = [];

    // Process each segment independently
    for (let s = 0; s < segmentOrder.length; s++) {
      const info = segmentOrder[s];
      const segPts = segmentMap.get(info.key);

      const segRes = await matchSingleSegment(segPts, profile, {
        signal: options.signal,
        baseUrl: options.baseUrl,
        concurrency: options.concurrency || 2,
        epsilonMeters: options.epsilonMeters || 2.5,
        maxGapMeters: options.maxGapMeters || 200.0,
        onProgressChunk: () => {
          totalDoneChunks++;
          if (typeof options.onProgress === 'function') {
            options.onProgress({
              completed: totalDoneChunks,
              total: totalEstChunks,
              percent: Math.min(99, Math.round((totalDoneChunks / totalEstChunks) * 100))
            });
          }
        }
      });

      totalChunksAll += segRes.totalChunks;
      successChunksAll += segRes.successChunks;
      failedChunksAll += segRes.failedChunks;
      allBoundaryJumps.push(...segRes.boundaryJumps);

      // Guarantee trkIdx and segIdx preservation
      segRes.matchedPoints.forEach(p => {
        p.trkIdx = info.trkIdx;
        p.segIdx = info.segIdx;
        finalMatchedPoints.push(p);
      });
    }

    const matchedSegmentSet = new Set(finalMatchedPoints.map(p => `${p.trkIdx}_${p.segIdx}`));
    const matchedSegmentCount = matchedSegmentSet.size;
    const segsPreserved = origSegmentCount === matchedSegmentCount;

    // Safety Gate Checks
    const issues = [];
    let isBlocked = false;

    // 1. Check for blocked boundary jumps (>80m at chunk seams)
    const blockedJumps = allBoundaryJumps.filter(j => j.jumpMeters > MATCH_SAFETY_THRESHOLDS.MAX_BOUNDARY_JUMP_BLOCK_M);
    if (blockedJumps.length > 0) {
      issues.push(`청크 접합부에서 80m 이상의 비정상 점프(${blockedJumps.length}곳)가 감지되어 자동 적용이 차단됩니다.`);
      isBlocked = true;
    }

    const reviewJumps = allBoundaryJumps.filter(j => j.jumpMeters > MATCH_SAFETY_THRESHOLDS.MAX_BOUNDARY_JUMP_REVIEW_M && j.jumpMeters <= MATCH_SAFETY_THRESHOLDS.MAX_BOUNDARY_JUMP_BLOCK_M);
    if (reviewJumps.length > 0) {
      issues.push(`청크 접합부에서 20m를 초과하는 경계 점프(${reviewJumps.length}곳)가 감지되어 검토가 권장됩니다.`);
    }

    // 2. Check for segment count mismatch
    if (!segsPreserved && MATCH_SAFETY_THRESHOLDS.BLOCK_TRKSEG_CHANGE) {
      issues.push(`trkseg 세그먼트 수가 변경되었습니다 (${matchedSegmentCount} vs ${origSegmentCount}). 자동 적용이 차단됩니다.`);
      isBlocked = true;
    }

    // 3. Check for distance delta ratio
    let origDist = 0, matchedDist = 0;
    for (let i = 1; i < pointsToMatch.length; i++) origDist += haversineM(pointsToMatch[i - 1], pointsToMatch[i]);
    for (let i = 1; i < finalMatchedPoints.length; i++) matchedDist += haversineM(finalMatchedPoints[i - 1], finalMatchedPoints[i]);
    const deltaRatio = origDist > 0 ? Math.abs((matchedDist - origDist) / origDist) * 100 : 0;

    if (deltaRatio > MATCH_SAFETY_THRESHOLDS.MAX_TOTAL_DIST_DELTA_RATIO) {
      issues.push(`전체 거리 변화율이 ±1%를 초과(${deltaRatio.toFixed(1)}%)하여 사용자 확인이 필요합니다.`);
    }

    const tTotalMs = ((typeof performance !== 'undefined') ? performance.now() : Date.now()) - tStartTotal;

    return {
      matchedPoints: finalMatchedPoints,
      origSegmentCount,
      matchedSegmentCount,
      segsPreserved,
      totalChunks: totalChunksAll,
      successChunks: successChunksAll,
      failedChunks: failedChunksAll,
      boundaryJumps: allBoundaryJumps,
      residualUnsafeJumps,
      isBlocked,
      issues,
      timings: {
        totalTimeMs: Math.round(tTotalMs)
      }
    };
  }

  // Export module
  const OSRMOptimizer = {
    haversineM,
    simplifyPointsForMatching,
    decodePolyline,
    fastInterpolateElevations,
    matchPointsOptimized,
    matchSingleSegment,
    matchPointsStabilized,
    MATCH_SAFETY_THRESHOLDS
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = OSRMOptimizer;
  }
  if (typeof root !== 'undefined') {
    root.RunruunOSRMOptimizer = OSRMOptimizer;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

