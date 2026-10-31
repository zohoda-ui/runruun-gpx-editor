import os
import json
import time
from playwright.sync_api import sync_playwright

CREATOR_ENGINE_PATH = "/Users/admin/Desktop/runruun/static/js/runruun-elevation.js"
SHARED_ENGINE_PATH = "/Users/admin/runruun-gpx-editor/runruun-shared-elevation-engine.js"
CREATOR_HTML_PATH = "/Users/admin/Desktop/runruun/static/gpx-creator/index.html"

REAL_DATASETS = [
    {"key": "cheonglyangsan_15k", "path": "/Users/admin/Desktop/gpx/cheonglyangsan_15k.gpx", "profile": "trail", "name": "청량산 15K"},
    {"key": "dynafit_taebaek_trail", "path": "/Users/admin/Desktop/gpx/dynafit_taebaek_trail.gpx", "profile": "trail", "name": "태백산 50K"},
    {"key": "chuncheon_full", "path": "/Users/admin/Desktop/gpx-road/chuncheon_full.gpx", "profile": "road", "name": "춘천 풀코스"},
    {"key": "suncheon_bay_ultra", "path": "/Users/admin/Desktop/gpx-road/suncheon_bay_ultra.gpx", "profile": "road", "name": "순천만 100K"},
    {"key": "YTN_seoulmarathon", "path": "/Users/admin/Desktop/gpx-road/YTN_seoulmarathon.gpx", "profile": "road", "name": "YTN 서울마라톤"},
    {"key": "2025mbnseoul", "path": "/Users/admin/Desktop/gpx-road/2025mbnseoul.gpx", "profile": "road", "name": "2025 MBN 서울"},
    {"key": "happy_trailrun_9k", "path": "/Users/admin/Desktop/gpx/happy_trailrun_9k.gpx", "profile": "trail", "name": "해피 트레일 9K"},
    {"key": "seoul100k_50k", "path": "/Users/admin/Desktop/gpx/seoul100k_50k.gpx", "profile": "trail", "name": "서울100K 50K"}
]

SYNTHETIC_TEST_CASES = {
    # 1. 1m 이하 고도 진동 (0.5m)
    "vibration_under_1m": [
        {"lat": 37.5 + i*0.0001, "lon": 127.0, "ele": 100.0 + (0.5 if i % 2 == 1 else 0.0)}
        for i in range(10)
    ],
    # 2. 1~2m 고도 진동 (1.5m)
    "vibration_1_to_2m": [
        {"lat": 37.5 + i*0.0001, "lon": 127.0, "ele": 100.0 + (1.5 if i % 2 == 1 else 0.0)}
        for i in range(10)
    ],
    # 3. 2~3m 고도 진동 (2.5m)
    "vibration_2_to_3m": [
        {"lat": 37.5 + i*0.0001, "lon": 127.0, "ele": 100.0 + (2.5 if i % 2 == 1 else 0.0)}
        for i in range(10)
    ],
    # 4. 연속 상승 후 급격한 하강
    "continuous_rise_sharp_drop": [
        {"lat": 37.5 + i*0.0001, "lon": 127.0, "ele": 100.0 + i*10.0} for i in range(6)
    ] + [
        {"lat": 37.5006, "lon": 127.0, "ele": 90.0}
    ],
    # 5. 연속 하강 후 급격한 상승
    "continuous_drop_sharp_rise": [
        {"lat": 37.5 + i*0.0001, "lon": 127.0, "ele": 150.0 - i*10.0} for i in range(6)
    ] + [
        {"lat": 37.5006, "lon": 127.0, "ele": 160.0}
    ],
    # 6. 시작점과 종점의 고도 차이
    "start_end_elevation_difference": [
        {"lat": 37.5000, "lon": 127.0, "ele": 100.0},
        {"lat": 37.5001, "lon": 127.0, "ele": 102.0},
        {"lat": 37.5002, "lon": 127.0, "ele": 101.0},
        {"lat": 37.5003, "lon": 127.0, "ele": 115.0}
    ],
    # 7. 짧은 급경사와 정상부 평탄 구간
    "steep_slope_flat_summit": [
        {"lat": 37.5000, "lon": 127.0, "ele": 100.0},
        {"lat": 37.5001, "lon": 127.0, "ele": 200.0},
        {"lat": 37.5002, "lon": 127.0, "ele": 200.2},
        {"lat": 37.5003, "lon": 127.0, "ele": 200.1},
        {"lat": 37.5004, "lon": 127.0, "ele": 150.0}
    ],
    # 8. 결측 고도와 연속 결측 구간
    "missing_elevation_gaps": [
        {"lat": 37.5000, "lon": 127.0, "ele": 100.0},
        {"lat": 37.5001, "lon": 127.0, "ele": None},
        {"lat": 37.5002, "lon": 127.0, "ele": None},
        {"lat": 37.5003, "lon": 127.0, "ele": 130.0},
        {"lat": 37.5004, "lon": 127.0, "ele": 120.0}
    ]
}

def run_phase5_tests():
    console_errors = []
    output = {
        "execution_date": time.strftime("%Y-%m-%d %H:%M:%S"),
        "summary": {},
        "real_datasets": {},
        "synthetic_cases": {},
        "performance": {},
        "console_errors": console_errors
    }

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        def on_console(msg):
            if msg.type in ["error"]:
                console_errors.append(f"[{msg.type}] {msg.text}")

        page.on("console", on_console)
        page.goto(f"file://{CREATOR_HTML_PATH}")
        page.add_script_tag(path=SHARED_ENGINE_PATH)
        page.add_script_tag(path=CREATOR_ENGINE_PATH)
        page.wait_for_timeout(500)

        # 1. 8개 실제 GPX 테스트
        for ds in REAL_DATASETS:
            path = ds["path"]
            profile = ds["profile"]
            name = ds["name"]

            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                gpx_content = f.read()

            res = page.evaluate("""async ([gpx, profKey]) => {
                // 1. 기존 Creator 실행 (공식 기준값)
                const t0_c = performance.now();
                const creatorRes = await RunruunElevationEngine.processGpx(gpx, { profile: profKey, bypassCache: true });
                const t1_c = performance.now();
                const creatorTime = t1_c - t0_c;

                const rawPoints = RunruunElevationEngine.parseGpx(gpx);

                // 2. Shared Engine - Creator 호환 모드 실행
                const t0_s = performance.now();
                const compatMethod = (profKey === 'trail') ? 'creator_trail' : 'creator_road';
                const sharedCompatStats = RunruunSharedElevationEngine.calculateElevationStats(rawPoints, { method: compatMethod });
                const t1_s = performance.now();
                const sharedCompatTime = t1_s - t0_s;

                // 3. Shared Engine - Hysteresis 실험 모드 실행
                const expMethod = (profKey === 'trail') ? 'shared_trail' : 'shared_road';
                const sharedExpStats = RunruunSharedElevationEngine.calculateElevationStats(rawPoints, { method: expMethod });

                // 4. Raw 통계
                const sharedRaw = RunruunSharedElevationEngine.calculateElevationStats(rawPoints, { method: 'raw' });

                // 5. DEM 통계
                const demMeasured = RunruunSharedElevationEngine.calculateElevationStats(rawPoints, { method: 'dem_measured' });
                const demInterp = RunruunSharedElevationEngine.calculateElevationStats(rawPoints, { method: 'dem_interpolated' });

                return {
                    creator: {
                        totalDistDisplay: creatorRes.stats.totalDist,
                        totalDistKm: Math.round(creatorRes.stats.rawTotalDistKm * 1000) / 1000,
                        eleGain: creatorRes.stats.eleGain,
                        eleLoss: creatorRes.stats.eleLoss,
                        vkm: creatorRes.stats.vkm,
                        timeMs: Math.round(creatorTime * 10) / 10
                    },
                    sharedCompat: {
                        totalDistKm: sharedCompatStats.totalDistKm,
                        eleGain: sharedCompatStats.eleGain,
                        eleLoss: sharedCompatStats.eleLoss,
                        vkm: (sharedCompatStats.totalDistKm > 0) ? Math.round((sharedCompatStats.eleGain / sharedCompatStats.totalDistKm) * 10) / 10 : 0,
                        pointCount: sharedCompatStats.pointCount,
                        timeMs: Math.round(sharedCompatTime * 10) / 10
                    },
                    sharedHysteresis: {
                        eleGain: sharedExpStats.eleGain,
                        eleLoss: sharedExpStats.eleLoss,
                        vkm: (sharedExpStats.totalDistKm > 0) ? Math.round((sharedExpStats.eleGain / sharedExpStats.totalDistKm) * 10) / 10 : 0
                    },
                    raw: {
                        eleGain: sharedRaw.eleGain,
                        eleLoss: sharedRaw.eleLoss
                    },
                    dem: {
                        measuredGain: demMeasured.eleGain,
                        interpGain: demInterp.eleGain
                    }
                };
            }""", [gpx_content, profile])

            # 비교 단언 및 차이 기록
            c_gain = res["creator"]["eleGain"]
            c_loss = res["creator"]["eleLoss"]
            s_gain = res["sharedCompat"]["eleGain"]
            s_loss = res["sharedCompat"]["eleLoss"]

            gain_diff = s_gain - c_gain
            loss_diff = s_loss - c_loss
            dist_diff_m = round(abs(res["creator"]["totalDistKm"] - res["sharedCompat"]["totalDistKm"]) * 1000, 1)

            output["real_datasets"][ds["key"]] = {
                "name": name,
                "profile": profile,
                "distanceKm": res["creator"]["totalDistKm"],
                "distDiffMeters": dist_diff_m,
                "creator": res["creator"],
                "sharedCompat": res["sharedCompat"],
                "sharedHysteresis": res["sharedHysteresis"],
                "raw": res["raw"],
                "dem": res["dem"],
                "gainDiff": gain_diff,
                "lossDiff": loss_diff,
                "exactMatch": (gain_diff == 0 and loss_diff == 0),
                "withinTolerance": (abs(gain_diff) <= 3 and abs(loss_diff) <= 6)
            }

        # 2. 합성 데이터 8종 테스트
        synth_results = page.evaluate("""(cases) => {
            const out = {};
            for (const [key, pts] of Object.entries(cases)) {
                // Creator Trail 및 Road 누적기로 테스트
                const trailRes = RunruunSharedElevationEngine.accumulateCreatorTrail(pts, 1.0);
                const roadRes = RunruunSharedElevationEngine.accumulateCreatorPivot(pts, 3.0);
                const rawGain = RunruunSharedElevationEngine.calculateDPlus(pts, { mode: 'raw' });
                const rawLoss = RunruunSharedElevationEngine.calculateDMinus(pts, { mode: 'raw' });
                const hystGain = RunruunSharedElevationEngine.calculateDPlus(pts, { mode: 'hysteresis', deadband: 2.0 });
                const hystLoss = RunruunSharedElevationEngine.calculateDMinus(pts, { mode: 'hysteresis', deadband: 2.0 });

                out[key] = {
                    pointCount: pts.length,
                    rawGain: rawGain,
                    rawLoss: rawLoss,
                    creatorTrailGain: trailRes.eleGain,
                    creatorTrailLoss: trailRes.eleLoss,
                    creatorRoadGain: roadRes.eleGain,
                    creatorRoadLoss: roadRes.eleLoss,
                    sharedHysteresisGain: hystGain,
                    sharedHysteresisLoss: hystLoss
                };
            }
            return out;
        }""", SYNTHETIC_TEST_CASES)

        output["synthetic_cases"] = synth_results

        # 3. 반복 실행 및 성능 측정 (청량산 15K 기준 10회)
        with open(REAL_DATASETS[0]["path"], "r", encoding="utf-8") as f:
            sample_gpx = f.read()

        perf_results = page.evaluate("""async (gpx) => {
            const rawPoints = RunruunElevationEngine.parseGpx(gpx);
            const creatorTimes = [];
            const sharedTimes = [];

            for (let i = 0; i < 5; i++) {
                const t0_c = performance.now();
                await RunruunElevationEngine.processGpx(gpx, { profile: 'trail', bypassCache: true });
                creatorTimes.push(performance.now() - t0_c);

                const t0_s = performance.now();
                RunruunSharedElevationEngine.calculateElevationStats(rawPoints, { method: 'creator_trail' });
                sharedTimes.push(performance.now() - t0_s);
            }

            const avgCreator = creatorTimes.reduce((a, b) => a + b, 0) / creatorTimes.length;
            const avgShared = sharedTimes.reduce((a, b) => a + b, 0) / sharedTimes.length;

            return {
                creatorTimesMs: creatorTimes.map(t => Math.round(t * 10) / 10),
                sharedTimesMs: sharedTimes.map(t => Math.round(t * 10) / 10),
                avgCreatorMs: Math.round(avgCreator * 10) / 10,
                avgSharedMs: Math.round(avgShared * 10) / 10,
                speedupFactor: Math.round((avgCreator / (avgShared || 1)) * 10) / 10
            };
        }""", sample_gpx)

        output["performance"] = perf_results

        browser.close()

    return output

if __name__ == "__main__":
    res = run_phase5_tests()
    out_file = "/Users/admin/runruun-gpx-editor/phase5_policy_integration_results.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(res, f, indent=2, ensure_ascii=False)
    print(f"Results saved to {out_file}")
    print(json.dumps(res, indent=2, ensure_ascii=False))
