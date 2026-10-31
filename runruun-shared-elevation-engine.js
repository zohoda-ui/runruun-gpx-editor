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
   * @returns {Array<Object>}
   */
  function resamplePoints(points, targetIntervalMeters) {
    if (!Array.isArray(points) || points.length < 2) {
      return (points || []).map(function (p) { return Object.assign({}, p); });
    }
    var interval = (typeof targetIntervalMeters === 'number' && targetIntervalMeters > 0)
      ? targetIntervalMeters
      : 5.0;

    var cumDists = calculateCumulativeDistances(points);
    var totalDist = cumDists[cumDists.length - 1];

    if (totalDist <= 0) {
      return [Object.assign({}, points[0])];
    }

    var numPoints = Math.max(2, Math.floor(totalDist / interval) + 1);
    var resampled = [];

    var srcIdx = 0;
    for (var i = 0; i < numPoints; i++) {
      var targetDist = (i === numPoints - 1) ? totalDist : (i * interval);

      while (srcIdx < cumDists.length - 2 && cumDists[srcIdx + 1] < targetDist) {
        srcIdx++;
      }

      var d0 = cumDists[srcIdx];
      var d1 = cumDists[srcIdx + 1];
      var segLen = d1 - d0;
      var ratio = (segLen > 0) ? (targetDist - d0) / segLen : 0;
      ratio = Math.max(0, Math.min(1, ratio));

      var p0 = points[srcIdx];
      var p1 = points[srcIdx + 1];

      var lat = p0.lat + (p1.lat - p0.lat) * ratio;
      var lon0 = p0.lon !== undefined ? p0.lon : p0.lng;
      var lon1 = p1.lon !== undefined ? p1.lon : p1.lng;
      var lon = lon0 + (lon1 - lon0) * ratio;

      var ele = null;
      var hasE0 = (p0.ele !== null && p0.ele !== undefined && !isNaN(p0.ele));
      var hasE1 = (p1.ele !== null && p1.ele !== undefined && !isNaN(p1.ele));
      if (hasE0 && hasE1) {
        ele = p0.ele + (p1.ele - p0.ele) * ratio;
      } else if (hasE0) {
        ele = p0.ele;
      } else if (hasE1) {
        ele = p1.ele;
      }

      var origEle = p0.originalEle !== undefined ? p0.originalEle : p0.ele;

      resampled.push({
        lat: lat,
        lon: lon,
        ele: ele !== null ? Math.round(ele * 10) / 10 : null,
        originalEle: origEle,
        dist: Math.round((targetDist / 1000) * 10000) / 10000,
        distMeters: targetDist,
        eleStatus: (ele !== null) ? 'interpolated' : 'failed',
        eleSource: p0.eleSource || 'Resampled'
      });
    }

    return resampled;
  }

  /**
   * 4. 물리적 경사도 한계 이상치 보정 (Gradient Spike Limiter)
   * 도로: 0.15 (15%), 트레일: 0.45 (45%)
   * 원본 배열 불변성 보장
   * @param {Array<Object>} points 
   * @param {Number} [maxSlopeGradient=0.45]
   * @returns {Array<Object>}
   */
  function limitGradientSpikes(points, maxSlopeGradient) {
    if (!Array.isArray(points) || points.length < 2) {
      return (points || []).map(function (p) { return Object.assign({}, p); });
    }
    var maxSlope = (typeof maxSlopeGradient === 'number' && maxSlopeGradient > 0)
      ? maxSlopeGradient
      : 0.45;

    var result = points.map(function (p) { return Object.assign({}, p); });

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
   * @returns {Array<Object>}
   */
  function spatialGaussianSmooth(points, sigmaMeters, resampleIntervalMeters) {
    if (!Array.isArray(points) || points.length === 0) return [];
    if (points.length < 3) {
      return points.map(function (p) { return Object.assign({}, p); });
    }

    var sigma = (typeof sigmaMeters === 'number' && sigmaMeters > 0) ? sigmaMeters : 15.0;
    var interval = (typeof resampleIntervalMeters === 'number' && resampleIntervalMeters > 0)
      ? resampleIntervalMeters
      : 5.0;

    var radiusMeters = 3.0 * sigma;
    var halfWindow = Math.max(1, Math.ceil(radiusMeters / interval));
    var twoSigmaSq = 2.0 * sigma * sigma;

    // 가우시안 가중치 테이블 사전 계산
    var weights = new Float64Array(halfWindow + 1);
    for (var w = 0; w <= halfWindow; w++) {
      var distM = w * interval;
      weights[w] = Math.exp(-(distM * distM) / twoSigmaSq);
    }

    var n = points.length;
    var smoothed = new Array(n);

    for (var i = 0; i < n; i++) {
      var pt = Object.assign({}, points[i]);
      if (pt.ele === null || pt.ele === undefined || isNaN(pt.ele)) {
        smoothed[i] = pt;
        continue;
      }

      var weightSum = weights[0];
      var eleSum = pt.ele * weights[0];

      for (var k = 1; k <= halfWindow; k++) {
        var wVal = weights[k];
        var leftIdx = i - k;
        var rightIdx = i + k;

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

    // --- 11가지 표준 모드 및 Phase 5 신규 통합 정책 매핑 ---
    if (method === 'creator_trail') {
      // Phase 5 Creator 호환 Trail 모드: 원본 고도(workingPoints) 대상 Creator Trail 누적기
      accMode = 'creator_trail';
      deadbandVal = opts.deadband !== undefined ? opts.deadband : 1.0;
    } else if (method === 'creator_road') {
      // Phase 5 Creator 호환 Road 모드: 10m 리샘플링 -> 15% 경사제한 -> 60m 가우시안 -> Creator Pivot 누적기
      filterType = 'creator_road';
      accMode = 'creator_pivot';
      thresholdVal = opts.threshold !== undefined ? opts.threshold : 3.0;
    } else if (method === 'shared_trail' || method === 'shared_hysteresis_trail') {
      // Phase 5 Shared Engine Trail 실험 정책: 5m 리샘플링 -> 45% 경사제한 -> 15m 가우시안 -> 2m Hysteresis
      filterType = 'shared_trail';
      accMode = 'hysteresis';
      deadbandVal = opts.deadband !== undefined ? opts.deadband : 1.0;
    } else if (method === 'shared_road' || method === 'shared_hysteresis_road') {
      // Phase 5 Shared Engine Road 실험 정책: 10m 리샘플링 -> 15% 경사제한 -> 60m 가우시안 -> 3m Hysteresis
      filterType = 'creator_road';
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

    // 가우시안 및 프로파일별 전처리 필터 적용
    if (filterType === 'gaussian') {
      var resampled = resamplePoints(workingPoints, 5.0);
      finalPoints = spatialGaussianSmooth(resampled, gaussianSigma, 5.0);
    } else if (filterType === 'creator_road') {
      var resampledRoad = resamplePoints(workingPoints, 10.0);
      var spikeLimitedRoad = limitGradientSpikes(resampledRoad, 0.15);
      finalPoints = spatialGaussianSmooth(spikeLimitedRoad, 60.0, 10.0);
    } else if (filterType === 'shared_trail') {
      var resampledTrail = resamplePoints(workingPoints, 5.0);
      var spikeLimitedTrail = limitGradientSpikes(resampledTrail, 0.45);
      finalPoints = spatialGaussianSmooth(spikeLimitedTrail, 15.0, 5.0);
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
        accMode = 'raw';
      }
    }

    // 최종 D+ / D- 누적 계산
    var gainLoss = calculateElevationGainLossInternal(finalPoints, {
      mode: accMode,
      threshold: thresholdVal,
      deadband: deadbandVal
    });

    // 고도 최소, 최대, 평균
    var minEle = Infinity;
    var maxEle = -Infinity;
    var eleSum = 0;
    var validCount = 0;

    for (var j = 0; j < finalPoints.length; j++) {
      var eVal = finalPoints[j].ele;
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
