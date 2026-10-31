import os
import hashlib
import json
import time
from playwright.sync_api import sync_playwright

CREATOR_ENGINE_PATH = "/Users/admin/Desktop/runruun/static/js/runruun-elevation.js"
SHARED_ENGINE_PATH = "/Users/admin/Desktop/runruun/static/js/runruun-shared-elevation-engine.js"
CREATOR_HTML_PATH = "/Users/admin/Desktop/runruun/static/gpx-creator/index.html"

TEST_FILES = {
    # 5대 기준 GPX
    "cheonglyangsan_15k": {
        "path": "/Users/admin/Desktop/gpx/cheonglyangsan_15k.gpx",
        "profile": "trail",
        "type": "trail"
    },
    "dynafit_taebaek_trail": {
        "path": "/Users/admin/Desktop/gpx/dynafit_taebaek_trail.gpx",
        "profile": "trail",
        "type": "trail"
    },
    "chuncheon_full": {
        "path": "/Users/admin/Desktop/gpx-road/chuncheon_full.gpx",
        "profile": "road",
        "type": "road"
    },
    "suncheon_bay_ultra": {
        "path": "/Users/admin/Desktop/gpx-road/suncheon_bay_ultra.gpx",
        "profile": "road",
        "type": "road"
    },
    "YTN_seoulmarathon": {
        "path": "/Users/admin/Desktop/gpx-road/YTN_seoulmarathon.gpx",
        "profile": "road",
        "type": "road"
    },
    # 추가 테스트 GPX
    "seoul_urban_marathon": {
        "path": "/Users/admin/Desktop/gpx-road/2025mbnseoul.gpx",
        "profile": "road",
        "type": "road"
    },
    "short_trail_happy_9k": {
        "path": "/Users/admin/Desktop/gpx/happy_trailrun_9k.gpx",
        "profile": "trail",
        "type": "trail"
    },
    "long_trail_seoul100k": {
        "path": "/Users/admin/Desktop/gpx/seoul100k_50k.gpx",
        "profile": "trail",
        "type": "trail"
    }
}

SYNTHETIC_TEST_CASES = {
    "null_elevation": """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Test">
  <trk><trkseg>
    <trkpt lat="37.5000" lon="127.0000"></trkpt>
    <trkpt lat="37.5010" lon="127.0000"><ele>100.0</ele></trkpt>
    <trkpt lat="37.5020" lon="127.0000"></trkpt>
    <trkpt lat="37.5030" lon="127.0000"><ele>130.0</ele></trkpt>
    <trkpt lat="37.5040" lon="127.0000"></trkpt>
  </trkseg></trk>
</gpx>""",
    "elevation_spike": """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Test">
  <trk><trkseg>
    <trkpt lat="37.5000" lon="127.0000"><ele>100.0</ele></trkpt>
    <trkpt lat="37.5005" lon="127.0000"><ele>350.0</ele></trkpt>
    <trkpt lat="37.5010" lon="127.0000"><ele>105.0</ele></trkpt>
  </trkseg></trk>
</gpx>""",
    "custom_crafted_route": """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Test">
  <trk><trkseg>
    <trkpt lat="37.5000" lon="127.0000"><ele>50.0</ele></trkpt>
    <trkpt lat="37.5010" lon="127.0000"><ele>55.0</ele></trkpt>
    <trkpt lat="37.5020" lon="127.0000"><ele>52.0</ele></trkpt>
    <trkpt lat="37.5030" lon="127.0000"><ele>65.0</ele></trkpt>
    <trkpt lat="37.5040" lon="127.0000"><ele>60.0</ele></trkpt>
  </trkseg></trk>
</gpx>"""
}

def run_shadow_tests():
    console_errors = []
    results = {
        "creator_settings": {
            "trail": {
                "resampleIntervalMeters": 5.0,
                "maxSlopeGradient": 0.45,
                "gaussianSigmaMeters": 15.0,
                "gainGaussianSigmaMeters": 15.0,
                "deadbandMeters": 1.0,
                "hysteresisThresholdMeters": 2.0
            },
            "road": {
                "resampleIntervalMeters": 10.0,
                "maxSlopeGradient": 0.15,
                "gaussianSigmaMeters": 60.0,
                "gainGaussianSigmaMeters": 60.0,
                "deadbandMeters": 3.0,
                "hysteresisThresholdMeters": 3.0
            }
        },
        "datasets": {},
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

        # Creator HTML 로드 및 스크립트 명시적 주입 (file:// 프로토콜 경로 호환)
        page.goto(f"file://{CREATOR_HTML_PATH}")
        page.add_script_tag(path=SHARED_ENGINE_PATH)
        page.add_script_tag(path=CREATOR_ENGINE_PATH)
        page.wait_for_timeout(500)

        # 1. 실제 파일 데이터셋 테스트
        for key, file_info in TEST_FILES.items():
            gpx_path = file_info["path"]
            profile = file_info["profile"]

            if not os.path.exists(gpx_path):
                results["datasets"][key] = {"error": f"File not found: {gpx_path}"}
                continue

            with open(gpx_path, "r", encoding="utf-8", errors="ignore") as f:
                gpx_text = f.read()

            t_start = time.time()
            eval_res = page.evaluate("""async ([gpx, profileKey]) => {
                const t0 = performance.now();
                const res = await RunruunElevationEngine.processGpx(gpx, { profile: profileKey, bypassCache: true });
                const t1 = performance.now();
                return {
                    creatorStats: res.stats,
                    shadowStats: res.shadowStats,
                    profile: res.profile,
                    profileName: res.profileName,
                    pointsCount: res.points.length,
                    gainPointsCount: res.gainPoints ? res.gainPoints.length : 0,
                    executionTimeMs: Math.round((t1 - t0) * 100) / 100
                };
            }""", [gpx_text, profile])
            t_end = time.time()

            # 차이 분석 계산
            c_stats = eval_res["creatorStats"]
            s_stats = eval_res["shadowStats"]

            dist_diff_km = round(abs(c_stats["rawTotalDistKm"] - s_stats["totalDistKm"]), 5)
            gain_diff_m = s_stats["finalGain"] - c_stats["eleGain"]
            loss_diff_m = s_stats["finalLoss"] - c_stats["eleLoss"]

            results["datasets"][key] = {
                "profile": profile,
                "type": file_info["type"],
                "creator": {
                    "totalDistDisplay": c_stats["totalDist"],
                    "totalDistKm": round(c_stats["rawTotalDistKm"], 3),
                    "eleGain": c_stats["eleGain"],
                    "eleLoss": c_stats["eleLoss"],
                    "minEle": c_stats["minEle"],
                    "maxEle": c_stats["maxEle"],
                    "vkm": c_stats["vkm"],
                    "pointCount": eval_res["pointsCount"]
                },
                "shadowEngine": {
                    "totalDistKm": round(s_stats["totalDistKm"], 3),
                    "rawGain": s_stats["rawGain"],
                    "rawLoss": s_stats["rawLoss"],
                    "th1Gain": s_stats["th1Gain"],
                    "th3Gain": s_stats["th3Gain"],
                    "finalGain": s_stats["finalGain"],
                    "finalLoss": s_stats["finalLoss"],
                    "vkm": s_stats["vkm"],
                    "resample5mCount": s_stats["resample5mPointCount"],
                    "resample10mCount": s_stats["resample10mPointCount"],
                    "displayPointCount": s_stats["displayPointCount"],
                    "demMeasuredGain": s_stats["demMeasuredGain"],
                    "demInterpGain": s_stats["demInterpGain"],
                    "computationTimeMs": s_stats["computationTimeMs"]
                },
                "comparison": {
                    "distDiffKm": dist_diff_km,
                    "gainDiffMeters": gain_diff_m,
                    "lossDiffMeters": loss_diff_m,
                    "vkmDiff": round(s_stats["vkm"] - c_stats["vkm"], 1),
                    "distMatch": dist_diff_km <= 0.001,
                    "gainMatch": (gain_diff_m == 0),
                    "creatorExecutionTimeMs": eval_res["executionTimeMs"]
                }
            }

        # 2. 합성 엣지 케이스 테스트
        for case_name, gpx_xml in SYNTHETIC_TEST_CASES.items():
            eval_res = page.evaluate("""async (gpx) => {
                const res = await RunruunElevationEngine.processGpx(gpx, { profile: 'road', bypassCache: true });
                return {
                    creatorStats: res.stats,
                    shadowStats: res.shadowStats
                };
            }""", gpx_xml)

            results["synthetic_cases"][case_name] = {
                "creatorGain": eval_res["creatorStats"]["eleGain"],
                "creatorLoss": eval_res["creatorStats"]["eleLoss"],
                "shadowGain": eval_res["shadowStats"]["finalGain"],
                "shadowLoss": eval_res["shadowStats"]["finalLoss"],
                "shadowRawGain": eval_res["shadowStats"]["rawGain"],
                "diff": eval_res["shadowStats"]["finalGain"] - eval_res["creatorStats"]["eleGain"]
            }

        browser.close()

    return results

if __name__ == "__main__":
    res = run_shadow_tests()
    out_file = "/Users/admin/runruun-gpx-editor/phase4_creator_shadow_results.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(res, f, indent=2, ensure_ascii=False)
    print(f"Results saved to {out_file}")
    print(json.dumps(res, indent=2, ensure_ascii=False))
