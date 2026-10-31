import os
import hashlib
import json
from playwright.sync_api import sync_playwright

ORIGINAL_FILES = {
    "cheonglyangsan_15k": "/Users/admin/Desktop/gpx/cheonglyangsan_15k.gpx",
    "dynafit_taebaek_trail": "/Users/admin/Desktop/gpx/dynafit_taebaek_trail.gpx",
    "chuncheon_full": "/Users/admin/Desktop/gpx-road/chuncheon_full.gpx",
    "suncheon_bay_ultra": "/Users/admin/Desktop/gpx-road/suncheon_bay_ultra.gpx",
    "YTN_seoulmarathon": "/Users/admin/Desktop/gpx-road/YTN_seoulmarathon.gpx"
}

ORIGINAL_EXPECTED_HASHES = {
    "cheonglyangsan_15k": "f43f5b5292b4ea3a35412204b1d50cfe0db3831d810e24b286adb124bfcedd07",
    "dynafit_taebaek_trail": "dddcb286536dbb913809a66bae1d909756ae0deb3d3d62591a1652b6cba6b1f1",
    "chuncheon_full": "4cabee88ec5e96ace0f50070485a977b58346e2d5e4070a1beb36eeea7c42bdb",
    "suncheon_bay_ultra": "eb84f263fcc2d98d7b70f3bb3126271d34c216664e85dce6dc0a523b6fe06708",
    "YTN_seoulmarathon": "2b4e5731998114cfb1532cf41604c66645b44919b7a543b459f687a802a1ced8"
}

# PHASE2_EDITOR_SHADOW_REPORT.md에 명시된 공식 실측 기준값
PHASE2_BASELINE = {
    "cheonglyangsan_15k": {
        "points": 11401,
        "distKm": 14.878,
        "rawGain": 1810,
        "rawLoss": 1782,
        "th1Gain": 1810,
        "th1Loss": 1782,
        "th3Gain": 1690,
        "th3Loss": 1663,
        "minEle": 193.0,
        "maxEle": 871.0
    },
    "dynafit_taebaek_trail": {
        "points": 1342,
        "distKm": 49.951,
        "rawGain": 1882,
        "rawLoss": 1882,
        "th1Gain": 1869,
        "th1Loss": 1868,
        "th3Gain": 1849,
        "th3Loss": 1850,
        "minEle": 619.6,
        "maxEle": 1534.7
    },
    "chuncheon_full": {
        "points": 10780,
        "distKm": 42.472,
        "rawGain": 330,
        "rawLoss": 326,
        "th1Gain": 208,
        "th1Loss": 204,
        "th3Gain": 159,
        "th3Loss": 154,
        "minEle": 71.0,
        "maxEle": 114.2
    },
    "suncheon_bay_ultra": {
        "points": 3902,
        "distKm": 103.197,
        "rawGain": 2545,
        "rawLoss": 2544,
        "th1Gain": 2372,
        "th1Loss": 2371,
        "th3Gain": 1887,
        "th3Loss": 1885,
        "minEle": 0.0,
        "maxEle": 313.2
    },
    "YTN_seoulmarathon": {
        "points": 2410,
        "distKm": 21.180,
        "rawGain": 359,
        "rawLoss": 340,
        "th1Gain": 328,
        "th1Loss": 307,
        "th3Gain": 269,
        "th3Loss": 247,
        "minEle": 14.4,
        "maxEle": 70.7
    }
}

def verify_file_hashes():
    results = {}
    for name, path in ORIGINAL_FILES.items():
        with open(path, "rb") as f:
            h = hashlib.sha256(f.read()).hexdigest()
        expected = ORIGINAL_EXPECTED_HASHES[name]
        results[name] = {
            "path": path,
            "hash": h,
            "match": (h == expected)
        }
    return results

def run_tests():
    index_html_path = os.path.abspath("/Users/admin/runruun-gpx-editor/index.html")
    console_errors = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        def on_console(msg):
            if msg.type in ["error"]:
                console_errors.append(f"[{msg.type}] {msg.text}")

        page.on("console", on_console)
        page.goto(f"file://{index_html_path}")
        page.wait_for_timeout(1000)

        # 1. 5대 GPX 기준 데이터셋 검증
        five_dataset_results = {}
        for name, path in ORIGINAL_FILES.items():
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                gpx_content = f.read()

            res = page.evaluate("""(xml) => {
                const editorPoints = parseGPX(xml);
                state.currentPoints = editorPoints;
                state.originalPoints = JSON.parse(JSON.stringify(editorPoints));
                state.originalElevations = editorPoints.map(p => p.ele);
                const stats = calculateStats(editorPoints);
                return {
                    pointCount: editorPoints.length,
                    totalDistKm: stats.totalDist / 1000,
                    gain: stats.gain,
                    loss: stats.loss,
                    minEle: stats.minEle,
                    maxEle: stats.maxEle,
                    sharedStats: state.sharedElevationStats
                };
            }""", gpx_content)

            baseline = PHASE2_BASELINE[name]
            dist_diff = abs(res["totalDistKm"] - baseline["distKm"])
            gain_diff = abs(res["gain"] - baseline["rawGain"])
            loss_diff = abs(res["loss"] - baseline["rawLoss"])
            th1_gain_diff = abs(res["sharedStats"]["th1Gain"] - baseline["th1Gain"])
            th3_gain_diff = abs(res["sharedStats"]["th3Gain"] - baseline["th3Gain"])

            five_dataset_results[name] = {
                "measured": res,
                "baseline": baseline,
                "distDiffKm": round(dist_diff, 5),
                "gainDiff": gain_diff,
                "lossDiff": loss_diff,
                "th1GainDiff": th1_gain_diff,
                "th3GainDiff": th3_gain_diff,
                "distPass": dist_diff <= 0.001,
                "gainPass": (gain_diff == 0),
                "lossPass": (loss_diff == 0),
                "th1Pass": (th1_gain_diff == 0),
                "th3Pass": (th3_gain_diff == 0),
                "pointsPass": (res["pointCount"] == baseline["points"])
            }

        # 2. 엣지 케이스 검증
        edge_case_results = page.evaluate("""() => {
            const results = {};

            // 2-1. 시작점 null 고도
            const ptsStartNull = [
                { lat: 37.5, lon: 127.0, ele: null },
                { lat: 37.5001, lon: 127.0, ele: 100 },
                { lat: 37.5002, lon: 127.0, ele: 120 }
            ];
            interpolateMissingElevations(ptsStartNull);
            const statsStartNull = calculateStats(ptsStartNull);
            results.startNull = {
                interpolatedEle0: ptsStartNull[0].ele,
                interpolatedStatus0: ptsStartNull[0].eleStatus,
                gain: statsStartNull.gain,
                loss: statsStartNull.loss,
                pass: ptsStartNull[0].ele === 100 && statsStartNull.gain === 20
            };

            // 2-2. 종료점 null 고도
            const ptsEndNull = [
                { lat: 37.5, lon: 127.0, ele: 100 },
                { lat: 37.5001, lon: 127.0, ele: 120 },
                { lat: 37.5002, lon: 127.0, ele: null }
            ];
            interpolateMissingElevations(ptsEndNull);
            const statsEndNull = calculateStats(ptsEndNull);
            results.endNull = {
                interpolatedEleLast: ptsEndNull[2].ele,
                interpolatedStatusLast: ptsEndNull[2].eleStatus,
                gain: statsEndNull.gain,
                loss: statsEndNull.loss,
                pass: ptsEndNull[2].ele === 120 && statsEndNull.gain === 20
            };

            // 2-3. 연속 null 고도 구간
            const ptsSeqNull = [
                { lat: 37.5, lon: 127.0, ele: 100 },
                { lat: 37.5001, lon: 127.0, ele: null },
                { lat: 37.5002, lon: 127.0, ele: null },
                { lat: 37.5003, lon: 127.0, ele: 130 }
            ];
            interpolateMissingElevations(ptsSeqNull);
            const statsSeqNull = calculateStats(ptsSeqNull);
            results.seqNull = {
                ele1: Math.round(ptsSeqNull[1].ele),
                ele2: Math.round(ptsSeqNull[2].ele),
                gain: statsSeqNull.gain,
                pass: Math.round(ptsSeqNull[1].ele) === 110 && Math.round(ptsSeqNull[2].ele) === 120 && statsSeqNull.gain === 30
            };

            // 2-4. 중복 좌표 및 거리 0 포인트
            const ptsDup = [
                { lat: 37.5, lon: 127.0, ele: 100 },
                { lat: 37.5, lon: 127.0, ele: 100 }, // 완벽 중복
                { lat: 37.501, lon: 127.0, ele: 150 }
            ];
            const statsDup = calculateStats(ptsDup);
            results.dupCoord = {
                totalDist: statsDup.totalDist,
                gain: statsDup.gain,
                pass: statsDup.gain === 50 && !isNaN(statsDup.totalDist)
            };

            // 2-5. 음수 고도 GPX (순천만 등 해수면 아래 -5m)
            const ptsNeg = [
                { lat: 37.5, lon: 127.0, ele: -5 },
                { lat: 37.501, lon: 127.0, ele: -2 },
                { lat: 37.502, lon: 127.0, ele: 10 }
            ];
            const statsNeg = calculateStats(ptsNeg);
            results.negElevation = {
                minEle: statsNeg.minEle,
                gain: statsNeg.gain,
                pass: statsNeg.minEle === -5 && statsNeg.gain === 15
            };

            // 2-6. 고도 급변 (스파이크) 테스트
            const ptsSpike = [
                { lat: 37.5, lon: 127.0, ele: 100 },
                { lat: 37.5001, lon: 127.0, ele: 300 }, // 200m 급상승
                { lat: 37.5002, lon: 127.0, ele: 105 }
            ];
            const statsSpike = calculateStats(ptsSpike);
            results.spike = {
                gain: statsSpike.gain,
                maxEle: statsSpike.maxEle,
                pass: statsSpike.maxEle === 300 && statsSpike.gain === 200
            };

            return results;
        }""")

        # 3. 다중 trkseg (168개 세그먼트) 보존 및 Export 재파싱 검증
        with open(ORIGINAL_FILES["cheonglyangsan_15k"], "r", encoding="utf-8") as f:
            cheonglyang_xml = f.read()

        multiseg_results = page.evaluate("""(xml) => {
            const points = parseGPX(xml);
            state.currentPoints = points;
            state.originalPoints = JSON.parse(JSON.stringify(points));
            state.originalElevations = points.map(p => p.ele);
            
            // 세그먼트 수 카운트
            const segSet = new Set(points.map(p => `${p.trkIdx ?? 0}_${p.segIdx ?? 0}`));
            const segCountBefore = segSet.size;

            // Export 실행
            const exportedGpx = exportToGPXString(points);

            // Export된 GPX 재파싱
            const reParsedPoints = parseGPX(exportedGpx);
            const reParsedSegSet = new Set(reParsedPoints.map(p => `${p.trkIdx ?? 0}_${p.segIdx ?? 0}`));
            const segCountAfter = reParsedSegSet.size;

            const statsBefore = calculateStats(points);
            const statsAfter = calculateStats(reParsedPoints);

            // 첫 포인트와 마지막 포인트 좌표 및 시간 무결성
            const pFirstB = points[0];
            const pFirstA = reParsedPoints[0];
            const pLastB = points[points.length - 1];
            const pLastA = reParsedPoints[reParsedPoints.length - 1];

            const coordMatch = Math.abs(pFirstB.lat - pFirstA.lat) < 1e-6 &&
                               Math.abs(pFirstB.lon - pFirstA.lon) < 1e-6 &&
                               Math.abs(pLastB.lat - pLastA.lat) < 1e-6 &&
                               Math.abs(pLastB.lon - pLastA.lon) < 1e-6;

            return {
                pointsBefore: points.length,
                pointsAfter: reParsedPoints.length,
                segCountBefore: segCountBefore,
                segCountAfter: segCountAfter,
                distBefore: statsBefore.totalDist,
                distAfter: statsAfter.totalDist,
                gainBefore: statsBefore.gain,
                gainAfter: statsAfter.gain,
                coordMatch: coordMatch,
                passPoints: points.length === reParsedPoints.length,
                passSegs: segCountBefore === 168 && segCountAfter === 168,
                passDist: Math.abs(statsBefore.totalDist - statsAfter.totalDist) < 1.0,
                passGain: statsBefore.gain === statsAfter.gain
            };
        }""", cheonglyang_xml)

        # 4. 수동 고도 수정, Undo/Redo, 원본 복원 검증
        undo_redo_results = page.evaluate("""() => {
            // 초기 포인트 설정
            const pts = [
                { lat: 37.5, lon: 127.0, ele: 100, eleStatus: 'original' },
                { lat: 37.501, lon: 127.0, ele: 120, eleStatus: 'original' },
                { lat: 37.502, lon: 127.0, ele: 140, eleStatus: 'original' }
            ];
            state.currentPoints = JSON.parse(JSON.stringify(pts));
            state.originalPoints = JSON.parse(JSON.stringify(pts));
            state.originalElevations = pts.map(p => p.ele);
            state.history = [];
            state.redoStack = [];

            // 1단계: 수동 고도 편집 전 pushHistory 호출 후 값 수정 (1번 포인트 120m -> 200m)
            pushHistory("수동 고도 변경");
            state.currentPoints[1].ele = 200;
            state.currentPoints[1].eleStatus = 'manual';
            const modifiedGain = calculateStats(state.currentPoints).gain;
            const modifiedStatus = state.currentPoints[1].eleStatus;

            // 2단계: Undo 실행
            undo();
            const undoGain = calculateStats(state.currentPoints).gain;
            const undoStatus = state.currentPoints[1].eleStatus;
            const undoEle = state.currentPoints[1].ele;

            // 3단계: Redo 실행
            redo();
            const redoGain = calculateStats(state.currentPoints).gain;
            const redoStatus = state.currentPoints[1].eleStatus;
            const redoEle = state.currentPoints[1].ele;

            // 4단계: 원본 복원 (resetToOrigBtn 활성화 후 클릭)
            document.getElementById('resetToOrigBtn').disabled = false;
            document.getElementById('resetToOrigBtn').click();
            const resetGain = calculateStats(state.currentPoints).gain;
            const resetStatus = state.currentPoints[1].eleStatus || 'original';
            const resetEle = state.currentPoints[1].ele;

            return {
                modifiedGain: modifiedGain,
                modifiedStatus: modifiedStatus,
                undoGain: undoGain,
                undoStatus: undoStatus,
                undoEle: undoEle,
                redoGain: redoGain,
                redoStatus: redoStatus,
                redoEle: redoEle,
                resetGain: resetGain,
                resetStatus: resetStatus,
                resetEle: resetEle,
                passModify: modifiedGain === 100 && modifiedStatus === 'manual',
                passUndo: undoGain === 40 && undoEle === 120 && undoStatus === 'original',
                passRedo: redoGain === 100 && redoEle === 200 && redoStatus === 'manual',
                passReset: resetGain === 40 && resetEle === 120 && resetStatus === 'original'
            };
        }""")

        browser.close()

    hash_results = verify_file_hashes()

    return {
        "file_hashes": hash_results,
        "five_datasets": five_dataset_results,
        "edge_cases": edge_case_results,
        "multiseg": multiseg_results,
        "undo_redo": undo_redo_results,
        "console_errors": console_errors
    }

if __name__ == "__main__":
    report = run_tests()
    print(json.dumps(report, indent=2, ensure_ascii=False))
