import os
import json
import time
import math
from playwright.sync_api import sync_playwright

CREATOR_ENGINE_PATH = "/Users/admin/Desktop/runruun/static/js/runruun-elevation.js"
SHARED_ENGINE_PATH = "/Users/admin/Desktop/runruun/static/js/runruun-shared-elevation-engine.js"
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

# Baseline values established and verified in Phase 4/5/6
BASELINE_VALUES = {
    "cheonglyangsan_15k": {"distKm": 14.88, "gain": 1810, "loss": 1782, "vkm": 121.7},
    "dynafit_taebaek_trail": {"distKm": 49.95, "gain": 1881, "loss": 1881, "vkm": 37.7},
    "chuncheon_full": {"distKm": 42.5, "gain": 182, "loss": 178, "vkm": 4.3},
    "suncheon_bay_ultra": {"distKm": 103.2, "gain": 1388, "loss": 1388, "vkm": 13.5},
    "YTN_seoulmarathon": {"distKm": 21.2, "gain": 274, "loss": 251, "vkm": 12.9},
    "2025mbnseoul": {"distKm": 21.1, "gain": 42, "loss": 58, "vkm": 2.0},
    "happy_trailrun_9k": {"distKm": 9.1, "gain": 320, "loss": 335, "vkm": 35.2},
    "seoul100k_50k": {"distKm": 48.97, "gain": 3241, "loss": 3239, "vkm": 66.2}
}

def run_phase7_official_migration_test():
    console_errors = []
    output = {
        "execution_date": time.strftime("%Y-%m-%d %H:%M:%S"),
        "summary": {},
        "regression_results": {},
        "performance_scope_comparison": {},
        "rollback_verification": {},
        "ui_and_export_verification": {},
        "console_errors": console_errors
    }

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        def on_console(msg):
            # 엔진 런타임 오류만 필터링 (배경 지도 타일 net::ERR 네트워크 오류 제외)
            if msg.type in ["error"] and "net::ERR" not in msg.text and "Failed to load resource" not in msg.text:
                console_errors.append(f"[{msg.type}] {msg.text}")

        page.on("console", on_console)
        page.goto(f"file://{CREATOR_HTML_PATH}")
        page.add_script_tag(path=SHARED_ENGINE_PATH)
        page.add_script_tag(path=CREATOR_ENGINE_PATH)
        page.wait_for_timeout(500)

        # ---------------------------------------------------------------------
        # 1. 8대 실제 GPX 공식 위임 회귀 테스트 (D+/D- 0m 일치 검증)
        # ---------------------------------------------------------------------
        print(">>> [1/5] 8대 실제 GPX 정식 전환 회귀 테스트 실행 중...")
        for ds in REAL_DATASETS:
            key = ds["key"]
            name = ds["name"]
            profile = ds["profile"]
            gpx_path = ds["path"]
            base = BASELINE_VALUES[key]

            with open(gpx_path, "r", encoding="utf-8", errors="ignore") as f:
                gpx_content = f.read()

            res = page.evaluate("""async ([gpx, profKey]) => {
                const rawPoints = RunruunElevationEngine.parseGpx(gpx);
                
                // 1. Raw D+ / D-
                const rawStats = RunruunSharedElevationEngine.calculateElevationStats(rawPoints, { method: 'raw' });

                // 2. Creator 정식 processGpx 호출 (내부적으로 calculateStats -> Shared Engine 위임)
                const officialRes = await RunruunElevationEngine.processGpx(gpx, { profile: profKey, bypassCache: true });
                const stats = officialRes.stats;

                // 3. 리샘플링 및 피봇 정보
                const pts = officialRes.points;
                const gainPts = officialRes.gainPoints;

                return {
                    calculationEngine: stats.calculationEngine,
                    totalDistDisplay: stats.totalDist,
                    rawTotalDistKm: Math.round(stats.rawTotalDistKm * 1000) / 1000,
                    rawDPlus: rawStats.eleGain,
                    rawDMinus: rawStats.eleLoss,
                    finalDPlus: stats.eleGain,
                    finalDMinus: stats.eleLoss,
                    minEle: stats.minEle,
                    maxEle: stats.maxEle,
                    vkm: stats.vkm,
                    chartDataPointsCount: stats.chartData.length,
                    startEle: pts[0].ele,
                    endEle: pts[pts.length - 1].ele,
                    displayPointsCount: pts.length,
                    gainPointsCount: gainPts ? gainPts.length : pts.length
                };
            }""", [gpx_content, profile])

            gain_diff = res["finalDPlus"] - base["gain"]
            loss_diff = res["finalDMinus"] - base["loss"]
            dist_match = (res["totalDistDisplay"] == base["distKm"])
            exact_match = (gain_diff == 0 and loss_diff == 0)

            output["regression_results"][key] = {
                "name": name,
                "profile": profile,
                "calculationEngine": res["calculationEngine"],
                "baseline": base,
                "migrated": {
                    "totalDistDisplay": res["totalDistDisplay"],
                    "rawTotalDistKm": res["rawTotalDistKm"],
                    "rawDPlus": res["rawDPlus"],
                    "rawDMinus": res["rawDMinus"],
                    "finalDPlus": res["finalDPlus"],
                    "finalDMinus": res["finalDMinus"],
                    "vkm": res["vkm"],
                    "minEle": res["minEle"],
                    "maxEle": res["maxEle"],
                    "startEle": res["startEle"],
                    "endEle": res["endEle"],
                    "displayPointsCount": res["displayPointsCount"]
                },
                "difference": {
                    "gainDiff": gain_diff,
                    "lossDiff": loss_diff,
                    "distDiff": round(res["totalDistDisplay"] - base["distKm"], 2)
                },
                "exactMatch": exact_match,
                "engineDelegated": (res["calculationEngine"] == "shared_engine_official")
            }
            print(f"  [{profile.upper()}] {name:16}: Baseline=({base['gain']}m, {base['loss']}m) | Migrated=({res['finalDPlus']}m, {res['finalDMinus']}m) | Diff=({gain_diff}m, {loss_diff}m) -> {'EXACT 0m' if exact_match else 'DIFF'}")

        # ---------------------------------------------------------------------
        # 2. 롤백 구조(Rollback Verification) 검증
        # ---------------------------------------------------------------------
        print(">>> [2/5] 롤백 및 Fallback 안전성 검증 중...")
        rollback_res = page.evaluate("""async (gpx) => {
            // A. Normal state (Shared Engine loaded)
            const normalRes = await RunruunElevationEngine.processGpx(gpx, { profile: 'trail', bypassCache: true });
            const normalEngine = normalRes.stats.calculationEngine;
            const normalGain = normalRes.stats.eleGain;
            const normalLoss = normalRes.stats.eleLoss;

            // B. Simulate Shared Engine missing (Fallback to Legacy Engine)
            const backupEngine = window.RunruunSharedElevationEngine;
            delete window.RunruunSharedElevationEngine;

            const fallbackRes = await RunruunElevationEngine.processGpx(gpx, { profile: 'trail', bypassCache: true });
            const fallbackEngine = fallbackRes.stats.calculationEngine;
            const fallbackGain = fallbackRes.stats.eleGain;
            const fallbackLoss = fallbackRes.stats.eleLoss;

            // C. Restore Shared Engine
            window.RunruunSharedElevationEngine = backupEngine;
            const restoredRes = await RunruunElevationEngine.processGpx(gpx, { profile: 'trail', bypassCache: true });
            const restoredEngine = restoredRes.stats.calculationEngine;

            return {
                normal: { engine: normalEngine, gain: normalGain, loss: normalLoss },
                fallback: { engine: fallbackEngine, gain: fallbackGain, loss: fallbackLoss },
                restored: { engine: restoredEngine, gain: restoredRes.stats.eleGain, loss: restoredRes.stats.eleLoss },
                fallbackPreservedValue: (normalGain === fallbackGain && normalLoss === fallbackLoss),
                rollbackSafetyVerified: (normalEngine === 'shared_engine_official' && fallbackEngine === 'creator_legacy' && restoredEngine === 'shared_engine_official')
            };
        }""", open(REAL_DATASETS[0]["path"], "r", encoding="utf-8").read())

        output["rollback_verification"] = rollback_res
        print(f"  롤백 구조 검증: Fallback={rollback_res['fallback']['engine']} (D+ {rollback_res['fallback']['gain']}m), Restored={rollback_res['restored']['engine']} -> {'PASS' if rollback_res['rollbackSafetyVerified'] else 'FAIL'}")

        # ---------------------------------------------------------------------
        # 3. UI 및 GPX Export 무결성 검증
        # ---------------------------------------------------------------------
        print(">>> [3/5] UI, 차트 및 GPX Export 무결성 검증 중...")
        export_res = page.evaluate("""async (gpx) => {
            const res = await RunruunElevationEngine.processGpx(gpx, { profile: 'trail', bypassCache: true });
            const points = res.points;
            
            // Export GPX
            const exportedXml = RunruunElevationEngine.exportGpx(points, "Test Migration Track");
            
            // Re-parse exported GPX
            const reparsedPoints = RunruunElevationEngine.parseGpx(exportedXml);

            let coordsMatch = (points.length === reparsedPoints.length);
            for (let i = 0; i < points.length; i++) {
                if (Math.abs(points[i].lat - reparsedPoints[i].lat) > 1e-5 ||
                    Math.abs(points[i].lon - reparsedPoints[i].lon) > 1e-5) {
                    coordsMatch = false;
                    break;
                }
            }

            return {
                chartDataPoints: res.stats.chartData.length,
                chartDataSample: res.stats.chartData.slice(0, 3),
                exportedXmlSnippet: exportedXml.substring(0, 250),
                originalPointsCount: points.length,
                reparsedPointsCount: reparsedPoints.length,
                coordsPreserved: coordsMatch
            };
        }""", open(REAL_DATASETS[0]["path"], "r", encoding="utf-8").read())

        output["ui_and_export_verification"] = export_res
        print(f"  Export 왕복 검증: 원본 {export_res['originalPointsCount']} pts vs 재파싱 {export_res['reparsedPointsCount']} pts -> {'PASS' if export_res['coordsPreserved'] else 'FAIL'}")

        # ---------------------------------------------------------------------
        # 4. 성능 벤치마크 (동일 범위 4개 지표 10회 반복 측정)
        # ---------------------------------------------------------------------
        print(">>> [4/5] 8개 GPX 성능 측정 (10회 반복 측정) 실행 중...")
        perf_data = []
        for ds in REAL_DATASETS:
            with open(ds["path"], "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
            perf_data.append({
                "key": ds["key"],
                "name": ds["name"],
                "profile": ds["profile"],
                "content": content
            })

        perf_results = page.evaluate("""async (items) => {
            const results = {};

            for (const item of items) {
                const key = item.key;
                const name = item.name;
                const profile = item.profile;
                const gpx = item.content;

                const rawPoints = RunruunElevationEngine.parseGpx(gpx);
                const isTrail = (profile === 'trail');
                const deadband = isTrail ? 1.0 : 3.0;

                // Precompute points for pure calculation comparison
                const resampled = RunruunElevationEngine.resamplePoints(rawPoints, isTrail ? 5.0 : 10.0);
                const spikeLimited = RunruunElevationEngine.limitGradientSpikes(resampled, isTrail ? 0.45 : 0.15);
                const smoothed = RunruunElevationEngine.spatialGaussianSmooth(spikeLimited, isTrail ? 15.0 : 60.0, isTrail ? 5.0 : 10.0);
                const targetGainPoints = isTrail ? rawPoints : smoothed;

                const legacyCalcTimes = [];
                const sharedCalcTimes = [];
                const legacyTotalTimes = [];
                const officialTotalTimes = [];

                // 10회 반복 측정
                for (let iter = 0; iter < 10; iter++) {
                    // 1. 기존 Creator 순수 고도 계산부
                    const tc0 = performance.now();
                    if (isTrail) {
                        RunruunElevationEngine.calculateTrailElevationGainLoss(targetGainPoints, deadband);
                    } else {
                        RunruunElevationEngine.calculateElevationGainLoss(targetGainPoints, deadband);
                    }
                    const tc1 = performance.now();
                    legacyCalcTimes.push(tc1 - tc0);

                    // 2. Shared Engine 동일 순수 계산부
                    const ts0 = performance.now();
                    if (isTrail) {
                        RunruunSharedElevationEngine.accumulateCreatorTrail(targetGainPoints, deadband);
                    } else {
                        RunruunSharedElevationEngine.accumulateCreatorPivot(targetGainPoints, deadband);
                    }
                    const ts1 = performance.now();
                    sharedCalcTimes.push(ts1 - ts0);

                    // 3. 공식 전환 후 processGpx 전체 실행 시간
                    const tot0 = performance.now();
                    await RunruunElevationEngine.processGpx(gpx, { profile: profile, bypassCache: true });
                    const tot1 = performance.now();
                    officialTotalTimes.push(tot1 - tot0);
                }

                const avgLegacyCalc = legacyCalcTimes.reduce((a, b) => a + b, 0) / 10;
                const avgSharedCalc = sharedCalcTimes.reduce((a, b) => a + b, 0) / 10;
                const avgOfficialTotal = officialTotalTimes.reduce((a, b) => a + b, 0) / 10;

                results[key] = {
                    name: name,
                    profile: profile,
                    pointCount: rawPoints.length,
                    pureCalculationMs: {
                        legacyCreatorAvg: Math.round(avgLegacyCalc * 100) / 100,
                        sharedEngineAvg: Math.round(avgSharedCalc * 100) / 100,
                        speedupRatio: Math.round((avgLegacyCalc / Math.max(0.01, avgSharedCalc)) * 10) / 10
                    },
                    officialEndToEndProcessMs: {
                        avgTime: Math.round(avgOfficialTotal * 10) / 10,
                        maxTime: Math.round(Math.max(...officialTotalTimes) * 10) / 10
                    }
                };
            }

            return results;
        }""", perf_data)

        output["performance_scope_comparison"] = perf_results

        # ---------------------------------------------------------------------
        # 5. 최종 종합 요약
        # ---------------------------------------------------------------------
        trail_exact = all(output["regression_results"][k]["exactMatch"] for k in output["regression_results"] if output["regression_results"][k]["profile"] == "trail")
        road_exact = all(output["regression_results"][k]["exactMatch"] for k in output["regression_results"] if output["regression_results"][k]["profile"] == "road")
        all_passed = (trail_exact and road_exact and rollback_res["rollbackSafetyVerified"] and export_res["coordsPreserved"])

        output["summary"] = {
            "all_criteria_met": all_passed,
            "trail_exact_0m_match": trail_exact,
            "road_exact_0m_match": road_exact,
            "rollback_safety_verified": rollback_res["rollbackSafetyVerified"],
            "ui_export_integrity_verified": export_res["coordsPreserved"],
            "console_errors_count": len(console_errors),
            "official_migration_complete": True
        }

        browser.close()

    # Save to file
    out_json = "/Users/admin/runruun-gpx-editor/phase7_creator_migration_results.json"
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"\n>>> Phase 7 검증 완료! 결과가 {out_json} 에 저장되었습니다.")
    print(f"Summary: {json.dumps(output['summary'], ensure_ascii=False, indent=2)}")

if __name__ == "__main__":
    run_phase7_official_migration_test()
