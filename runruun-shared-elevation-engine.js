/**
 * RunRuun Shared Elevation Engine v1.0.0
 * 
 * GPX Creator & GPX Editor 공통 고도/거리 계산 코어 엔진
 * 
 * [특징]
 * - 외부 라이브러리 의존성 0 (Zero-dependency Vanilla JS)
 * - 순수 함수(Pure function) 기반 입력 불변성(Immutability) 100% 보장
 * - UMD 지원 (Browser, Node.js, Web Worker 범용 호환)
 * - 11가지 계산 모드 및 필터-누적기 독립 조합 지원
 * - 결측 고도 임의 0m 대입 금지 및 고도 상태(measured/interpolated/failed) 분리
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    // Node.js CommonJS
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    // AMD
    define([], factory);
  } else {
    // Browser Global or Web Worker
    var globalScope = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis);
    globalScope.RunruunSharedElevationEngine = factory();
  }
})(this, function () {
  'use strict';

  var EARTH_RADIUS_METERS = 6371000;

  /**
   * 1. Haversine 거리 계산 (미터 단위)
   * @param {Object} p1 { lat, lon }
   * @param {Object} p2 { lat, lon }
   * @param {String} [unit='m'] 'm' | 'km'
   * @returns {Number} 거리
   */
  function haversineDistance(p1, p2, unit) {
    if (!p1 || !p2) return 0;
    var lat1 = Number(p1.lat);
    var lon1 = Number(p1.lon !== undefined ? p1.lon : p1.lng);
    var lat2 = Number(p2.lat);
    var lon2 = Number(p2.lon !== undefined ? p2.lon : p2.lng);

    if (isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)) {
      return 0;
    }

    if (lat1 === lat2 && lon1 === lon2) {
      return 0;
    }

    var rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad;
    var dLon = (lon2 - lon1) * rad;
    var phi1 = lat1 * rad;
    var phi2 = lat2 * rad;

    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(phi1) * Math.cos(phi2) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    // 부동소수점 오차로 a가 1을 초과하는 경우 방어
    var clampedA = Math.min(1, Math.max(0, a));
    var c = 2 * Math.atan2(Math.sqrt(clampedA), Math.sqrt(1 - clampedA));
    var distMeters = EARTH_RADIUS_METERS * c;

    return (unit === 'km') ? distMeters / 1000 : distMeters;
  }

  /**
   * 2. 누적 거리 배열 계산
   * @param {Array<Object>} points [{ lat, lon }, ...]
   * @returns {Array<Number>} 포인트별 누적 거리 (m)
   */
  function calculateCumulativeDistances(points) {
    if (!Array.isArray(points) || points.length === 0) return [];
    var cumDists = new Array(points.length);
    cumDists[0] = 0;
    var total = 0;

    for (var i = 1; i < points.length; i++) {
      var d = haversineDistance(points[i - 1], points[i], 'm');
      total += d;
      cumDists[i] = total;
    }
    return cumDists;
  }

  /**
   * 3. 등간격 리샘플링 (누적 거리 기준 선형 보간)
   * 원본 배열 불변성 보장, 새 포인트 배열 반환
   * @param {Array<Object>} points 
   * @param {Number} [targetIntervalMeters=5.0]
   * @param {Object} [options={}]
   * @returns {Array<Object>}
   */
  function resamplePoints(points, targetIntervalMeters, options) {
    if (!Array.isArray(points) || points.length < 2) {
      return (points || []).map(function (p) { return Object.assign({}, p); });
    }
    var interval = (typeof targetIntervalMeters === 'number' && targetIntervalMeters > 0)
      ? targetIntervalMeters
      : 5.0;
    var opts = options || {};
    var isCreatorMode = (opts.mode === 'creator' || opts.preserveEndpoint === true);

    var cumDists = calculateCumulativeDistances(points);
    var totalDist = cumDists[cumDists.length - 1];

    if (totalDist <= 0) {
      return [Object.assign({}, points[0])];
    }

    if (isCreatorMode) {
      // Creator 호환 정밀 리샘플링: 10m/5m 정규 간격 포인트 생성 + 마지막 정규 샘플 보존 + 실제 종점 별도 추가 (중복 방지)
      var resampled = [];
      var p0 = points[0];
      var e0 = (p0 && p0.ele !== null && !isNaN(p0.ele)) ? Math.round(Number(p0.ele) * 10) / 10 : null;
      resampled.push({
        lat: p0.lat,
        lon: p0.lon !== undefined ? p0.lon : p0.lng,
        ele: e0,
        originalEle: p0.originalEle !== undefined ? p0.originalEle : p0.ele,
        dist: 0,
        distMeters: 0,
        eleStatus: (e0 !== null) ? 'original' : 'failed',
        eleSource: p0.eleSource || 'GPX'
      });

      var currentTargetDist = interval;
      var rawIdx = 0;

      while (currentTargetDist < totalDist) {
        while (rawIdx < points.length - 1 && cumDists[rawIdx + 1] < currentTargetDist) {
          rawIdx++;
        }
        if (rawIdx >= points.length - 1) break;

        var dStart = cumDists[rawIdx];
        var dEnd = cumDists[rawIdx + 1];
        var segLen = dEnd - dStart;
        var ratio = segLen > 0 ? (currentTargetDist - dStart) / segLen : 0;

        var pA = points[rawIdx];
        var pB = points[rawIdx + 1];

        var lat = pA.lat + (pB.lat - pA.lat) * ratio;
        var lonA = pA.lon !== undefined ? pA.lon : pA.lng;
        var lonB = pB.lon !== undefined ? pB.lon : pB.lng;
        var lon = lonA + (lonB - lonA) * ratio;

        var eleA = (pA.ele !== null && !isNaN(pA.ele)) ? Math.round(Number(pA.ele) * 10) / 10 : null;
        var eleB = (pB.ele !== null && !isNaN(pB.ele)) ? Math.round(Number(pB.ele) * 10) / 10 : null;
        var interpEle = null;
        if (eleA !== null && eleB !== null) {
          interpEle = Math.round((eleA + (eleB - eleA) * ratio) * 10) / 10;
        } else if (eleA !== null) {
          interpEle = eleA;
        } else if (eleB !== null) {
          interpEle = eleB;
        }

        var origEleA = pA.originalEle !== undefined ? pA.originalEle : pA.ele;
        var origEleB = pB.originalEle !== undefined ? pB.originalEle : pB.ele;

        resampled.push({
          lat: lat,
          lon: lon,
          ele: interpEle,
          originalEle: ratio < 0.5 ? origEleA : origEleB,
          dist: Math.round((currentTargetDist / 1000) * 10000) / 10000,
          distMeters: currentTargetDist,
          eleStatus: (interpEle !== null) ? 'interpolated' : 'failed',
          eleSource: pA.eleSource || 'Resampled'
        });

        currentTargetDist += interval;
      }

      // 종점 포인트 추가 (정규 샘플과 동일 거리인 경우 중복 추가 방지)
      var lastIdx = points.length - 1;
      var lastRaw = points[lastIdx];
      var lastEle = (lastRaw && lastRaw.ele !== null && !isNaN(lastRaw.ele)) ? Math.round(Number(lastRaw.ele) * 10) / 10 : null;
      var lastDistKm = Math.round((totalDist / 1000) * 10000) / 10000;

      if (resampled.length === 0 || Math.abs(resampled[resampled.length - 1].distMeters - totalDist) > 0.001) {
        resampled.push({
          lat: lastRaw.lat,
          lon: lastRaw.lon !== undefined ? lastRaw.lon : lastRaw.lng,
          ele: lastEle,
          originalEle: lastRaw.originalEle !== undefined ? lastRaw.originalEle : lastRaw.ele,
          dist: lastDistKm,
          distMeters: totalDist,
          eleStatus: (lastEle !== null) ? 'original' : 'failed',
          eleSource: lastRaw.eleSource || 'GPX'
        });
      }

      return resampled;
    }

    // 기본 Shared Engine 리샘플링
    var numPoints = Math.max(2, Math.floor(totalDist / interval) + 1);
    var defaultResampled = [];

    var srcIdx = 0;
    for (var i = 0; i < numPoints; i++) {
      var targetDist = (i === numPoints - 1) ? totalDist : (i * interval);

      while (srcIdx < cumDists.length - 2 && cumDists[srcIdx + 1] < targetDist) {
        srcIdx++;
      }

      var d0 = cumDists[srcIdx];
      var d1 = cumDists[srcIdx + 1];
      var segLenDef = d1 - d0;
      var ratioDef = (segLenDef > 0) ? (targetDist - d0) / segLenDef : 0;
      ratioDef = Math.max(0, Math.min(1, ratioDef));

      var p0Def = points[srcIdx];
      var p1Def = points[srcIdx + 1];

      var latDef = p0Def.lat + (p1Def.lat - p0Def.lat) * ratioDef;
      var lon0Def = p0Def.lon !== undefined ? p0Def.lon : p0Def.lng;
      var lon1Def = p1Def.lon !== undefined ? p1Def.lon : p1Def.lng;
      var lonDef = lon0Def + (lon1Def - lon0Def) * ratioDef;

      var eleDef = null;
      var hasE0 = (p0Def.ele !== null && p0Def.ele !== undefined && !isNaN(p0Def.ele));
      var hasE1 = (p1Def.ele !== null && p1Def.ele !== undefined && !isNaN(p1Def.ele));
      if (hasE0 && hasE1) {
        eleDef = p0Def.ele + (p1Def.ele - p0Def.ele) * ratioDef;
      } else if (hasE0) {
        eleDef = p0Def.ele;
      } else if (hasE1) {
        eleDef = p1Def.ele;
      }

      var origEleDef = p0Def.originalEle !== undefined ? p0Def.originalEle : p0Def.ele;

      defaultResampled.push({
        lat: latDef,
        lon: lonDef,
        ele: eleDef !== null ? Math.round(eleDef * 10) / 10 : null,
        originalEle: origEleDef,
        dist: Math.round((targetDist / 1000) * 10000) / 10000,
        distMeters: targetDist,
        eleStatus: (eleDef !== null) ? 'interpolated' : 'failed',
        eleSource: p0Def.eleSource || 'Resampled'
      });
    }

    return defaultResampled;
  }

  /**
   * 4. 물리적 경사도 한계 이상치 보정 (Gradient Spike Limiter)
   * 도로: 0.15 (15%), 트레일: 0.45 (45%)
   * 원본 배열 불변성 보장
   * @param {Array<Object>} points 
   * @param {Number} [maxSlopeGradient=0.45]
   * @returns {Array<Object>}
   */
  /**
   * 4. 물리적 경사도 한계 이상치 보정 (Gradient Spike Limiter)
   * 도로: 0.15 (15%), 트레일: 0.45 (45%)
   * 원본 배열 불변성 보장
   * @param {Array<Object>} points 
   * @param {Number} [maxSlopeGradient=0.45]
   * @param {Object} [options={}]
   * @returns {Array<Object>}
   */
  function limitGradientSpikes(points, maxSlopeGradient, options) {
    if (!Array.isArray(points) || points.length < 2) {
      return (points || []).map(function (p) { return Object.assign({}, p); });
    }
    var maxSlope = (typeof maxSlopeGradient === 'number' && maxSlopeGradient > 0)
      ? maxSlopeGradient
      : 0.45;
    var opts = options || {};
    var isCreatorMode = (opts.mode === 'creator' || opts.bidirectional === true);

    var result = points.map(function (p) { return Object.assign({}, p); });
    var n = result.length;

    if (isCreatorMode) {
      var bufferMeters = (typeof opts.bufferMeters === 'number') ? opts.bufferMeters : 0.3;
      // 1. 순방향 클램핑 패스 (Forward Pass with +0.3m buffer)
      for (var fIdx = 1; fIdx < n; fIdx++) {
        var pPrevF = result[fIdx - 1];
        var pCurF = result[fIdx];
        if (pPrevF.ele === null || pCurF.ele === null || isNaN(pPrevF.ele) || isNaN(pCurF.ele)) continue;
        var ddF = haversineDistance(pPrevF, pCurF, 'm');
        if (ddF <= 0) continue;
        var dhF = pCurF.ele - pPrevF.ele;
        var maxDhF = (maxSlope * ddF) + bufferMeters;
        if (Math.abs(dhF) > maxDhF) {
          result[fIdx].ele = Math.round((pPrevF.ele + (dhF > 0 ? 1 : -1) * maxDhF) * 10) / 10;
          result[fIdx].eleStatus = 'filtered';
        }
      }
      // 2. 역방향 클램핑 패스 (Backward Pass with +0.3m buffer)
      for (var bIdx = n - 2; bIdx >= 0; bIdx--) {
        var pNextB = result[bIdx + 1];
        var pCurB = result[bIdx];
        if (pNextB.ele === null || pCurB.ele === null || isNaN(pNextB.ele) || isNaN(pCurB.ele)) continue;
        var ddB = haversineDistance(pNextB, pCurB, 'm');
        if (ddB <= 0) continue;
        var dhB = pCurB.ele - pNextB.ele;
        var maxDhB = (maxSlope * ddB) + bufferMeters;
        if (Math.abs(dhB) > maxDhB) {
          result[bIdx].ele = Math.round((pNextB.ele + (dhB > 0 ? 1 : -1) * maxDhB) * 10) / 10;
          result[bIdx].eleStatus = 'filtered';
        }
      }
      return result;
    }

    // 기본 단방향 패스
    for (var i = 1; i < result.length; i++) {
      var prev = result[i - 1];
      var curr = result[i];

      if (prev.ele === null || curr.ele === null || isNaN(prev.ele) || isNaN(curr.ele)) {
        continue;
      }

      var dist = haversineDistance(prev, curr, 'm');
      if (dist <= 0) continue;

      var maxAllowedDelta = dist * maxSlope;
      var delta = curr.ele - prev.ele;

      if (Math.abs(delta) > maxAllowedDelta) {
        var limitedEle = (delta > 0)
          ? prev.ele + maxAllowedDelta
          : prev.ele - maxAllowedDelta;
        curr.ele = Math.round(limitedEle * 10) / 10;
        curr.eleStatus = 'filtered';
      }
    }

    return result;
  }

  /**
   * 5. 공간 가우시안 스무딩 (Spatial Gaussian Smooth)
   * 거리($\Delta d$)를 기반으로 가중치를 부여하는 1D 공간 필터
   * 원본 배열 불변성 보장
   * @param {Array<Object>} points 
   * @param {Number} [sigmaMeters=15.0]
   * @param {Number} [resampleIntervalMeters=5.0]
   * @param {Object} [options={}]
   * @returns {Array<Object>}
   */
  function spatialGaussianSmooth(points, sigmaMeters, resampleIntervalMeters, options) {
    if (!Array.isArray(points) || points.length === 0) return [];
    if (points.length < 3) {
      return points.map(function (p) { return Object.assign({}, p); });
    }

    var sigma = (typeof sigmaMeters === 'number' && sigmaMeters > 0) ? sigmaMeters : 15.0;
    var interval = (typeof resampleIntervalMeters === 'number' && resampleIntervalMeters > 0)
      ? resampleIntervalMeters
      : 5.0;
    var opts = options || {};
    var isClamp = (opts.boundary === 'clamp');

    var n = points.length;

    if (isClamp) {
      // Creator 호환 Border Clamping: 경계 밖 인덱스는 가장자리 값 복제 후 정규화 커널 합성
      var sigmaPts = Math.max(0.5, sigma / interval);
      var kernelRadius = Math.ceil(3.0 * sigmaPts);
      var kernelSize = 2 * kernelRadius + 1;
      var kernel = new Float64Array(kernelSize);
      var kernelSum = 0;
      for (var k = 0; k < kernelSize; k++) {
        var xVal = k - kernelRadius;
        var kval = Math.exp(-0.5 * (xVal / sigmaPts) * (xVal / sigmaPts));
        kernel[k] = kval;
        kernelSum += kval;
      }
      for (var normIdx = 0; normIdx < kernelSize; normIdx++) {
        kernel[normIdx] /= kernelSum;
      }

      var clampedSmoothed = new Array(n);
      for (var pIdx = 0; pIdx < n; pIdx++) {
        var curP = Object.assign({}, points[pIdx]);
        if (curP.ele === null || curP.ele === undefined || isNaN(curP.ele)) {
          clampedSmoothed[pIdx] = curP;
          continue;
        }
        var cSum = 0;
        for (var w = -kernelRadius; w <= kernelRadius; w++) {
          var targetIdx = pIdx + w;
          if (targetIdx < 0) targetIdx = 0;
          else if (targetIdx >= n) targetIdx = n - 1;
          var tEle = points[targetIdx].ele;
          cSum += (tEle !== null && !isNaN(tEle) ? tEle : curP.ele) * kernel[w + kernelRadius];
        }
        curP.ele = Math.round(cSum * 10) / 10;
        clampedSmoothed[pIdx] = curP;
      }
      return clampedSmoothed;
    }

    var radiusMeters = 3.0 * sigma;
    var halfWindow = Math.max(1, Math.ceil(radiusMeters / interval));
    var twoSigmaSq = 2.0 * sigma * sigma;

    // 가우시안 가중치 테이블 사전 계산
    var weights = new Float64Array(halfWindow + 1);
    for (var w = 0; w <= halfWindow; w++) {
      var distM = w * interval;
      weights[w] = Math.exp(-(distM * distM) / twoSigmaSq);
    }

    var smoothed = new Array(n);

    for (var i = 0; i < n; i++) {
      var pt = Object.assign({}, points[i]);
      if (pt.ele === null || pt.ele === undefined || isNaN(pt.ele)) {
        smoothed[i] = pt;
        continue;
      }

      var weightSum = weights[0];
      var eleSum = pt.ele * weights[0];

      for (var kw = 1; kw <= halfWindow; kw++) {
        var wVal = weights[kw];
        var leftIdx = i - kw;
        var rightIdx = i + kw;

        if (leftIdx >= 0) {
          var leftEle = points[leftIdx].ele;
          if (leftEle !== null && !isNaN(leftEle)) {
            eleSum += leftEle * wVal;
            weightSum += wVal;
          }
        }
        if (rightIdx < n) {
          var rightEle = points[rightIdx].ele;
          if (rightEle !== null && !isNaN(rightEle)) {
            eleSum += rightEle * wVal;
            weightSum += wVal;
          }
        }
      }

      pt.ele = (weightSum > 0) ? Math.round((eleSum / weightSum) * 10) / 10 : pt.ele;
      smoothed[i] = pt;
    }

    return smoothed;
  }

  /**
   * 6. 결측 고도 보간 (임의 0m 대입 금지, 유효값 간 선형 보간)
   * 원본 배열 불변성 보장
   * @param {Array<Object>} points 
   * @returns {Object} { points: Array<Object>, allMissing: boolean, missingCount: number }
   */
  function interpolateElevations(points) {
    if (!Array.isArray(points) || points.length === 0) {
      return { points: [], allMissing: true, missingCount: 0 };
    }

    var result = points.map(function (p) { return Object.assign({}, p); });
    var missingIndices = [];

    for (var i = 0; i < result.length; i++) {
      var e = result[i].ele;
      if (e === null || e === undefined || isNaN(e)) {
        missingIndices.push(i);
      }
    }

    if (missingIndices.length === 0) {
      return { points: result, allMissing: false, missingCount: 0 };
    }

    if (missingIndices.length === result.length) {
      // 전체가 결측인 경우: 0m로 변환하지 않고 null 유지 및 allMissing 플래그 반환
      return { points: result, allMissing: true, missingCount: missingIndices.length };
    }

    var cumDists = calculateCumulativeDistances(result);

    // 앞부분 결측치: 첫 유효 고도로 채움
    var firstValid = 0;
    while (firstValid < result.length && (result[firstValid].ele === null || isNaN(result[firstValid].ele))) {
      firstValid++;
    }
    for (var f = 0; f < firstValid; f++) {
      result[f].ele = result[firstValid].ele;
      result[f].eleStatus = 'interpolated';
    }

    // 뒷부분 결측치: 마지막 유효 고도로 채움
    var lastValid = result.length - 1;
    while (lastValid >= 0 && (result[lastValid].ele === null || isNaN(result[lastValid].ele))) {
      lastValid--;
    }
    for (var l = lastValid + 1; l < result.length; l++) {
      result[l].ele = result[lastValid].ele;
      result[l].eleStatus = 'interpolated';
    }

    // 중간 결측치: 거리 비율 선형 보간
    var curValid = firstValid;
    for (var m = firstValid + 1; m <= lastValid; m++) {
      if (result[m].ele !== null && !isNaN(result[m].ele)) {
        if (m > curValid + 1) {
          var dStart = cumDists[curValid];
          var dEnd = cumDists[m];
          var eStart = result[curValid].ele;
          var eEnd = result[m].ele;
          var spanDist = dEnd - dStart;

          for (var k = curValid + 1; k < m; k++) {
            var ratio = (spanDist > 0) ? (cumDists[k] - dStart) / spanDist : 0;
            result[k].ele = Math.round((eStart + (eEnd - eStart) * ratio) * 10) / 10;
            result[k].eleStatus = 'interpolated';
          }
        }
        curValid = m;
      }
    }

    return {
      points: result,
      allMissing: false,
      missingCount: missingIndices.length
    };
  }

  /**
   * 7. 누적 상승고도 (D+) 전용 계산기
   * @param {Array<Number|Object>} elevations 고도 배열 또는 포인트 객체 배열
   * @param {Object} [options={}] { mode: 'raw'|'threshold'|'hysteresis', threshold: 1.0, deadband: 1.0 }
   * @returns {Number} D+ (m)
   */
  function calculateDPlus(elevations, options) {
    var stats = calculateElevationGainLossInternal(elevations, options);
    return stats.eleGain;
  }

  /**
   * 8. 누적 하강고도 (D-) 전용 계산기
   * @param {Array<Number|Object>} elevations 고도 배열 또는 포인트 객체 배열
   * @param {Object} [options={}] { mode: 'raw'|'threshold'|'hysteresis', threshold: 1.0, deadband: 1.0 }
   * @returns {Number} D- (m)
   */
  function calculateDMinus(elevations, options) {
    var stats = calculateElevationGainLossInternal(elevations, options);
    return stats.eleLoss;
  }

  /**
   * 내부 D+/D- 계산 함수
   */
  function calculateElevationGainLossInternal(input, options) {
    if (!Array.isArray(input) || input.length < 2) {
      return { eleGain: 0, eleLoss: 0 };
    }
    var opts = options || {};
    var mode = (opts.mode || 'threshold').toLowerCase();

    // Creator 호환 모드는 포인트 객체 원본(결측치, 거리 등)을 직접 참조
    if (mode === 'creator_trail') {
      return accumulateCreatorTrail(input, opts.deadband !== undefined ? opts.deadband : 1.0);
    } else if (mode === 'creator_pivot' || mode === 'creator_road') {
      return accumulateCreatorPivot(input, opts.threshold !== undefined ? opts.threshold : 3.0);
    }

    // 입력이 포인트 객체 배열인 경우 고도값 추출
    var eles = new Float64Array(input.length);
    for (var i = 0; i < input.length; i++) {
      var item = input[i];
      var val = (typeof item === 'object' && item !== null) ? item.ele : item;
      eles[i] = (val !== null && val !== undefined && !isNaN(val)) ? Number(val) : 0;
    }

    if (mode === 'raw') {
      return accumulateThreshold(eles, 0);
    } else if (mode === 'threshold') {
      var th = (typeof opts.threshold === 'number' && opts.threshold >= 0) ? opts.threshold : 1.0;
      return accumulateThreshold(eles, th);
    } else if (mode === 'hysteresis') {
      var db = (typeof opts.deadband === 'number' && opts.deadband >= 0) ? opts.deadband : 1.0;
      return accumulateHysteresis(eles, db);
    }

    // 기본: 1m threshold
    return accumulateThreshold(eles, 1.0);
  }

  /**
   * 단순 임계값 누적기 (Editor 표준)
   */
  function accumulateThreshold(eles, threshold) {
    var gain = 0;
    var loss = 0;
    var last = eles[0];

    for (var i = 1; i < eles.length; i++) {
      var diff = eles[i] - last;
      if (Math.abs(diff) >= threshold) {
        if (diff > 0) gain += diff;
        else loss += Math.abs(diff);
        last = eles[i];
      }
    }
    return {
      eleGain: Math.round(gain),
      eleLoss: Math.round(loss)
    };
  }

  /**
   * Hysteresis 상태 머신 누적기
   */
  function accumulateHysteresis(eles, deadband) {
    var gain = 0;
    var loss = 0;
    var minTrack = eles[0];
    var maxTrack = eles[0];
    var dir = 0; // 0: 정체, 1: 상승, -1: 하강

    for (var i = 1; i < eles.length; i++) {
      var cur = eles[i];

      if (dir === 0) {
        if (cur - minTrack >= deadband) {
          gain += (cur - minTrack);
          maxTrack = cur;
          dir = 1;
        } else if (maxTrack - cur >= deadband) {
          loss += (maxTrack - cur);
          minTrack = cur;
          dir = -1;
        }
      } else if (dir === 1) {
        if (cur > maxTrack) {
          gain += (cur - maxTrack);
          maxTrack = cur;
        } else if (maxTrack - cur >= deadband) {
          loss += (maxTrack - cur);
          minTrack = cur;
          dir = -1;
        }
      } else if (dir === -1) {
        if (cur < minTrack) {
          loss += (minTrack - cur);
          minTrack = cur;
        } else if (cur - minTrack >= deadband) {
          gain += (cur - minTrack);
          maxTrack = cur;
          dir = 1;
        }
      }
    }

    return {
      eleGain: Math.round(gain),
      eleLoss: Math.round(loss)
    };
  }

  /**
   * Creator 호환 Trail 데드밴드 누적기 (Creator 표준 재현)
   * 결측 구간 단절 리셋(wasGap) 및 1.0m 데드밴드 상태 머신 적용
   */
  function accumulateCreatorTrail(points, deadband) {
    if (!Array.isArray(points) || points.length === 0) {
      return { eleGain: 0, eleLoss: 0 };
    }
    var db = (typeof deadband === 'number' && deadband >= 0) ? deadband : 1.0;
    var eleGain = 0;
    var eleLoss = 0;
    var minTrackElev = null;
    var maxTrackElev = null;
    var direction = 0; // 0: 초기 미정, 1: 상승, -1: 하강
    var wasGap = false;

    // 첫 번째 유효 고도값 탐색
    var startIdx = 0;
    while (startIdx < points.length) {
      var item0 = points[startIdx];
      var e0 = (typeof item0 === 'object' && item0 !== null) ? item0.ele : item0;
      if (e0 !== null && e0 !== undefined && !isNaN(e0)) {
        minTrackElev = Number(e0);
        maxTrackElev = Number(e0);
        break;
      }
      startIdx++;
    }

    if (minTrackElev !== null) {
      for (var i = startIdx + 1; i < points.length; i++) {
        var item = points[i];
        var cur = (typeof item === 'object' && item !== null) ? item.ele : item;

        // 결측치(null, undefined, NaN) 처리: 결측 구간을 건너뛰면서 직후 포인트와 인위적으로 연결되지 않도록 플래그 설정
        if (cur === null || cur === undefined || typeof cur !== 'number' || isNaN(cur)) {
          wasGap = true;
          continue;
        }

        cur = Number(cur);

        // 결측 후 복귀 시: 직전 고도와 단절 처리하고 현재 고도 기준으로 상태 머신 리셋
        if (wasGap) {
          minTrackElev = cur;
          maxTrackElev = cur;
          direction = 0;
          wasGap = false;
          continue;
        }

        if (direction === 0) {
          if (cur - minTrackElev >= db) {
            eleGain += (cur - minTrackElev);
            maxTrackElev = cur;
            direction = 1;
          } else if (maxTrackElev - cur >= db) {
            eleLoss += (maxTrackElev - cur);
            minTrackElev = cur;
            direction = -1;
          }
        } else if (direction === 1) {
          if (cur > maxTrackElev) {
            eleGain += (cur - maxTrackElev);
            maxTrackElev = cur;
          } else if (maxTrackElev - cur >= db) {
            eleLoss += (maxTrackElev - cur);
            minTrackElev = cur;
            direction = -1;
          }
        } else if (direction === -1) {
          if (cur < minTrackElev) {
            eleLoss += (minTrackElev - cur);
            minTrackElev = cur;
          } else if (cur - minTrackElev >= db) {
            eleGain += (cur - minTrackElev);
            maxTrackElev = cur;
            direction = 1;
          }
        }
      }
    }

    return {
      eleGain: Math.round(eleGain),
      eleLoss: Math.round(eleLoss)
    };
  }

  /**
   * Creator 호환 Road 피봇 추세 반전 누적기 (Creator Road 표준 재현)
   * excursionThreshold (기본 3.0m) 기준 피봇 확정 및 종점 피봇 연결
   */
  function accumulateCreatorPivot(points, excursionThreshold) {
    if (!Array.isArray(points) || points.length <= 1) {
      return { eleGain: 0, eleLoss: 0, confirmedPivots: [] };
    }
    var threshold = (typeof excursionThreshold === 'number' && excursionThreshold >= 0) ? excursionThreshold : 3.0;

    // 포인트 배열 정규화 (dist, ele 확보)
    var pts = new Array(points.length);
    var runningDist = 0;
    for (var i = 0; i < points.length; i++) {
      var item = points[i];
      var ele = (typeof item === 'object' && item !== null) ? Number(item.ele || 0) : Number(item || 0);
      var dist = (typeof item === 'object' && item !== null && item.dist !== undefined)
        ? Number(item.dist)
        : (i > 0 ? (runningDist += haversineDistance(points[i - 1], points[i], 'km')) : 0);
      pts[i] = { ele: ele, dist: dist, idx: i };
    }

    var trend = 0; // 0: 미정, 1: 상승, -1: 하강
    var lastPivot = { dist: pts[0].dist, ele: pts[0].ele, type: 'START', idx: 0 };
    var candidatePeak = lastPivot;
    var candidateValley = lastPivot;
    var confirmedPivots = [lastPivot];

    for (var j = 1; j < pts.length; j++) {
      var curEle = pts[j].ele;
      var curDist = pts[j].dist;

      if (trend === 0) {
        if (curEle - lastPivot.ele >= threshold) {
          trend = 1;
          candidatePeak = { dist: curDist, ele: curEle, type: 'PEAK', idx: j };
        } else if (lastPivot.ele - curEle >= threshold) {
          trend = -1;
          candidateValley = { dist: curDist, ele: curEle, type: 'VALLEY', idx: j };
        }
      } else if (trend === 1) {
        if (curEle > candidatePeak.ele) {
          candidatePeak = { dist: curDist, ele: curEle, type: 'PEAK', idx: j };
        } else if (candidatePeak.ele - curEle >= threshold) {
          // 하강 반전 확정 -> candidatePeak 피봇 등록
          confirmedPivots.push(candidatePeak);
          lastPivot = candidatePeak;
          trend = -1;
          candidateValley = { dist: curDist, ele: curEle, type: 'VALLEY', idx: j };
        }
      } else if (trend === -1) {
        if (curEle < candidateValley.ele) {
          candidateValley = { dist: curDist, ele: curEle, type: 'VALLEY', idx: j };
        } else if (curEle - candidateValley.ele >= threshold) {
          // 상승 반전 확정 -> candidateValley 피봇 등록
          confirmedPivots.push(candidateValley);
          lastPivot = candidateValley;
          trend = 1;
          candidatePeak = { dist: curDist, ele: curEle, type: 'PEAK', idx: j };
        }
      }
    }

    // 종점 피봇 등록
    var lastPt = { dist: pts[pts.length - 1].dist, ele: pts[pts.length - 1].ele, type: 'END', idx: pts.length - 1 };
    if (trend === 1) {
      confirmedPivots.push(candidatePeak);
    } else if (trend === -1) {
      confirmedPivots.push(candidateValley);
    }
    confirmedPivots.push(lastPt);

    // 상승/하강 누적 집계
    var eleGain = 0;
    var eleLoss = 0;
    for (var k = 1; k < confirmedPivots.length; k++) {
      var deltaEle = confirmedPivots[k].ele - confirmedPivots[k - 1].ele;
      if (deltaEle > 0) {
        eleGain += deltaEle;
      } else {
        eleLoss += Math.abs(deltaEle);
      }
    }

    return {
      eleGain: Math.round(eleGain),
      eleLoss: Math.round(eleLoss),
      confirmedPivots: confirmedPivots
    };
  }

  /**
   * 9. 통합 통계 및 고도 프로파일 계산기
   * 11개 벤치마크 모드 및 필터-누적기 자유 조합 지원
   * @param {Array<Object>} points 
   * @param {Object} [options={}]
   * @returns {Object} ElevationStats
   */
  function calculateElevationStats(points, options) {
    var startTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    if (!Array.isArray(points) || points.length === 0) {
      return {
        totalDistMeters: 0,
        totalDistKm: 0,
        eleGain: 0,
        eleLoss: 0,
        minEle: 0,
        maxEle: 0,
        avgEle: 0,
        pointCount: 0,
        processedPoints: [],
        method: options && options.method ? options.method : 'raw',
        computationTimeMs: 0
      };
    }

    var opts = options || {};
    var method = (opts.method || 'raw').toLowerCase();

    // 1. 결측치 안전 보간 (불변)
    var interpRes = interpolateElevations(points);
    var workingPoints = interpRes.points;

    // 2. 거리 계산
    var cumDists = calculateCumulativeDistances(workingPoints);
    var totalDistMeters = cumDists[cumDists.length - 1] || 0;
    var totalDistKm = totalDistMeters / 1000;

    var filterType = 'none';
    var accMode = 'threshold';
    var thresholdVal = 1.0;
    var deadbandVal = 1.0;
    var gaussianSigma = 15.0;
    var isDemSim = false;

    // --- 11가지 표준 모드 및 Phase 5/7 신규 통합 정책 매핑 ---
    if (method === 'creator_trail') {
      // Phase 7 Creator 호환 Trail 모드: 5m 리샘플링 -> 45% 경사제한 -> 15m 클램핑 가우시안 (차트용) + 원본 고도 1.0m 데드밴드 누적
      filterType = 'creator_trail';
      accMode = 'creator_trail';
      deadbandVal = opts.deadband !== undefined ? opts.deadband : 1.0;
    } else if (method === 'creator_road') {
      // Phase 7 Creator 호환 Road 모드: 10m 정밀 리샘플링 -> 15% 양방향 버퍼 경사제한 -> 60m 클램핑 가우시안 -> 3.0m 피봇 누적
      filterType = 'creator_road';
      accMode = 'creator_pivot';
      thresholdVal = opts.threshold !== undefined ? opts.threshold : 3.0;
    } else if (method === 'shared_trail' || method === 'shared_hysteresis_trail') {
      // Phase 7 Shared Engine Trail 실험 정책: 5m 리샘플링 -> 45% 경사제한 -> 15m 가우시안 -> 2m Hysteresis
      filterType = 'shared_trail';
      accMode = 'hysteresis';
      deadbandVal = opts.deadband !== undefined ? opts.deadband : 1.0;
    } else if (method === 'shared_road' || method === 'shared_hysteresis_road') {
      // Phase 7 Shared Engine Road 실험 정책: 10m 리샘플링 -> 15% 경사제한 -> 60m 가우시안 -> 3m Hysteresis
      filterType = 'shared_road';
      accMode = 'hysteresis';
      deadbandVal = opts.deadband !== undefined ? opts.deadband : 3.0;
    } else if (method === 'raw') {
      accMode = 'raw';
    } else if (method === 'threshold_1m') {
      accMode = 'threshold';
      thresholdVal = 1.0;
    } else if (method === 'threshold_3m') {
      accMode = 'threshold';
      thresholdVal = 3.0;
    } else if (method.indexOf('gaussian') === 0) {
      filterType = 'gaussian';
      accMode = 'raw';
      if (method === 'gaussian_15m') gaussianSigma = 15.0;
      else if (method === 'gaussian_25m') gaussianSigma = 25.0;
      else if (method === 'gaussian_35m') gaussianSigma = 35.0;
      else if (method === 'gaussian_60m') gaussianSigma = 60.0;
      else if (opts.gaussianSigma) gaussianSigma = opts.gaussianSigma;
    } else if (method === 'hysteresis_1m') {
      accMode = 'hysteresis';
      deadbandVal = 1.0;
    } else if (method === 'hysteresis_3m') {
      accMode = 'hysteresis';
      deadbandVal = 3.0;
    } else if (method === 'dem_measured' || method === 'dem_interpolated') {
      isDemSim = true;
    } else if (method === 'custom') {
      filterType = opts.filter || 'none';
      accMode = opts.accumulator || 'threshold';
      thresholdVal = opts.threshold !== undefined ? opts.threshold : 1.0;
      deadbandVal = opts.deadband !== undefined ? opts.deadband : 1.0;
      gaussianSigma = opts.gaussianSigma !== undefined ? opts.gaussianSigma : 15.0;
    }

    var finalPoints = workingPoints;
    var targetGainPoints = workingPoints;

    // 가우시안 및 프로파일별 전처리 필터 적용
    if (filterType === 'gaussian') {
      var resampled = resamplePoints(workingPoints, 5.0);
      finalPoints = spatialGaussianSmooth(resampled, gaussianSigma, 5.0);
      targetGainPoints = finalPoints;
    } else if (filterType === 'creator_road') {
      var resampledRoad = resamplePoints(workingPoints, 10.0, { mode: 'creator' });
      var spikeLimitedRoad = limitGradientSpikes(resampledRoad, 0.15, { mode: 'creator' });
      finalPoints = spatialGaussianSmooth(spikeLimitedRoad, 60.0, 10.0, { boundary: 'clamp' });
      targetGainPoints = finalPoints;
    } else if (filterType === 'creator_trail') {
      var resampledTrail = resamplePoints(workingPoints, 5.0, { mode: 'creator' });
      var spikeLimitedTrail = limitGradientSpikes(resampledTrail, 0.45, { mode: 'creator' });
      finalPoints = spatialGaussianSmooth(spikeLimitedTrail, 15.0, 5.0, { boundary: 'clamp' });
      targetGainPoints = workingPoints; // Creator Trail은 원본 고도(workingPoints) 대상 누적
    } else if (filterType === 'shared_trail') {
      var resampledSharedTrail = resamplePoints(workingPoints, 5.0);
      var spikeLimitedSharedTrail = limitGradientSpikes(resampledSharedTrail, 0.45);
      finalPoints = spatialGaussianSmooth(spikeLimitedSharedTrail, 15.0, 5.0);
      targetGainPoints = finalPoints;
    } else if (filterType === 'shared_road') {
      var resampledSharedRoad = resamplePoints(workingPoints, 10.0);
      var spikeLimitedSharedRoad = limitGradientSpikes(resampledSharedRoad, 0.15);
      finalPoints = spatialGaussianSmooth(spikeLimitedSharedRoad, 60.0, 10.0);
      targetGainPoints = finalPoints;
    }

    // DEM 시뮬레이션 모드 처리
    if (isDemSim) {
      var sampleCount = Math.min(96, workingPoints.length);
      var step = (workingPoints.length - 1) / (sampleCount - 1);
      var sampleIndices = [];
      for (var s = 0; s < sampleCount; s++) {
        sampleIndices.push(Math.round(s * step));
      }

      if (method === 'dem_measured') {
        // 96개 표본 지점만 추출
        finalPoints = sampleIndices.map(function (idx) {
          var p = Object.assign({}, workingPoints[idx]);
          p.eleStatus = 'measured';
          return p;
        });
        targetGainPoints = finalPoints;
        accMode = 'raw';
      } else if (method === 'dem_interpolated') {
        // 96개 표본 간 선형 보간 고도로 재구성
        var interpEles = new Array(workingPoints.length);
        for (var seg = 0; seg < sampleIndices.length - 1; seg++) {
          var idxA = sampleIndices[seg];
          var idxB = sampleIndices[seg + 1];
          var eleA = workingPoints[idxA].ele || 0;
          var eleB = workingPoints[idxB].ele || 0;
          var dA = cumDists[idxA];
          var dB = cumDists[idxB];
          var segDist = dB - dA;
          for (var k = idxA; k <= idxB; k++) {
            var r = (segDist > 0) ? (cumDists[k] - dA) / segDist : 0;
            interpEles[k] = eleA + (eleB - eleA) * r;
          }
        }
        finalPoints = workingPoints.map(function (p, idx) {
          var clone = Object.assign({}, p);
          clone.ele = Math.round(interpEles[idx] * 10) / 10;
          clone.eleStatus = sampleIndices.indexOf(idx) !== -1 ? 'measured' : 'interpolated';
          return clone;
        });
        targetGainPoints = finalPoints;
        accMode = 'raw';
      }
    }

    // 최종 D+ / D- 누적 계산
    var gainLoss = calculateElevationGainLossInternal(targetGainPoints, {
      mode: accMode,
      threshold: thresholdVal,
      deadband: deadbandVal
    });

    // 고도 최소, 최대, 평균
    var extremaPoints = (filterType === 'creator_trail') ? workingPoints : finalPoints;
    var minEle = Infinity;
    var maxEle = -Infinity;
    var eleSum = 0;
    var validCount = 0;

    for (var j = 0; j < extremaPoints.length; j++) {
      var eVal = extremaPoints[j].ele;
      if (eVal !== null && !isNaN(eVal)) {
        if (eVal < minEle) minEle = eVal;
        if (eVal > maxEle) maxEle = eVal;
        eleSum += eVal;
        validCount++;
      }
    }

    if (validCount === 0) {
      minEle = 0;
      maxEle = 0;
    }

    var endTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    var computationTimeMs = Math.round((endTime - startTime) * 100) / 100;

    return {
      totalDistMeters: Math.round(totalDistMeters * 10) / 10,
      totalDistKm: Math.round(totalDistKm * 1000) / 1000,
      eleGain: gainLoss.eleGain,
      eleLoss: gainLoss.eleLoss,
      minEle: minEle === Infinity ? 0 : Math.round(minEle * 10) / 10,
      maxEle: maxEle === -Infinity ? 0 : Math.round(maxEle * 10) / 10,
      avgEle: validCount > 0 ? Math.round((eleSum / validCount) * 10) / 10 : 0,
      pointCount: finalPoints.length,
      processedPoints: finalPoints,
      method: method,
      optionsUsed: {
        filter: filterType,
        accumulator: accMode,
        threshold: thresholdVal,
        deadband: deadbandVal,
        gaussianSigma: gaussianSigma
      },
      computationTimeMs: computationTimeMs
    };
  }

  // 모듈 Export 인터페이스
  return {
    version: '1.0.0',
    haversineDistance: haversineDistance,
    calculateCumulativeDistances: calculateCumulativeDistances,
    resamplePoints: resamplePoints,
    limitGradientSpikes: limitGradientSpikes,
    spatialGaussianSmooth: spatialGaussianSmooth,
    interpolateElevations: interpolateElevations,
    calculateDPlus: calculateDPlus,
    calculateDMinus: calculateDMinus,
    accumulateCreatorTrail: accumulateCreatorTrail,
    accumulateCreatorPivot: accumulateCreatorPivot,
    calculateElevationStats: calculateElevationStats
  };
});
