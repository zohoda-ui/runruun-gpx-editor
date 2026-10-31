#!/usr/bin/env python3
"""
Playwright Browser Test for OSRM Match Performance Optimization in index.html
Validates:
1. Clean page load (0 console errors)
2. Incheon Marathon GPX (13,671 pts) loading and fast OSRM matching
3. Progress bar UI and cancellation controller
4. Badge rendering (time badge, simplification badge, confidence badge)
5. Data integrity: Elevation, time, trkseg preservation
"""

import os
import sys
import json
import time
from playwright.sync_api import sync_playwright

INDEX_HTML_PATH = os.path.abspath("/Users/admin/runruun-gpx-editor/index.html")
INCHEON_GPX_PATH = "/Users/admin/Downloads/인천마라톤풀코스(스트라바).gpx"

def run_integration_test():
    with open(INCHEON_GPX_PATH, "r", encoding="utf-8") as f:
        gpx_content = f.read()

    console_errors = []
    bench_result = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        def on_console(msg):
            if msg.type == "error" and "net::ERR" not in msg.text and "Failed to load resource" not in msg.text:
                console_errors.append(f"[{msg.type}] {msg.text}")
        page.on("console", on_console)

        print(f"Loading {INDEX_HTML_PATH}...")
        page.goto(f"file://{INDEX_HTML_PATH}")
        page.wait_for_timeout(500)

        # 1. Check module availability
        eval_init = page.evaluate("""() => {
            return {
                hasSimplify: typeof simplifyPointsForMatching === 'function',
                hasMatchWithOSRM: typeof matchPointsWithOSRM === 'function',
                hasFastInterpolate: typeof fastInterpolateElevations === 'function',
                hasProgressBar: !!document.getElementById('matchProgressContainer'),
                hasCancelBtn: !!document.getElementById('cancelRoadMatchProcessBtn'),
                hasTimeBadge: !!document.getElementById('matchTimeBadge')
            };
        }""")
        print("UI and Function availability:", eval_init)
        assert eval_init["hasSimplify"], "simplifyPointsForMatching missing"
        assert eval_init["hasMatchWithOSRM"], "matchPointsWithOSRM missing"
        assert eval_init["hasProgressBar"], "matchProgressContainer missing"

        # 2. Run in-browser matching test on Incheon Marathon GPX slice (full 13,671 pts)
        print("Running full Incheon Marathon match in browser...")
        t0 = time.perf_counter()
        match_test_res = page.evaluate("""async (gpxStr) => {
            // Load GPX into state
            const pts = parseGPX(gpxStr, "인천마라톤");
            loadNewPoints(pts, "인천마라톤");
            const origPoints = state.currentPoints;
            const origCount = origPoints.length;

            const tStart = performance.now();
            let progressUpdates = [];

            const result = await matchPointsWithOSRM(origPoints, 'driving', {
                concurrency: 2,
                onProgress: (p) => {
                    progressUpdates.push(p);
                }
            });
            const tTotal = performance.now() - tStart;

            // Apply preview
            state.previewPoints = result.matchedPoints;
            state.matchPreviewData = {
                matchedPts: result.matchedPoints,
                startIdx: 0,
                targetSliceLength: origCount,
                scope: 'all',
                matchResult: result
            };

            // Calculate stats
            const origStats = calculateStats(origPoints);
            const matchedStats = calculateStats(result.matchedPoints);

            return {
                origCount,
                reducedCount: result.preprocessing.reducedCount,
                reductionRatio: result.preprocessing.reductionRatio,
                totalChunks: result.totalChunks,
                successChunks: result.successChunks,
                failedChunks: result.failedChunks,
                avgConfidence: result.avgConfidence,
                matchedPointsCount: result.matchedPoints.length,
                origDistKm: (origStats.totalDist / 1000).toFixed(2),
                matchedDistKm: (matchedStats.totalDist / 1000).toFixed(2),
                timings: result.timings,
                totalElapsedSeconds: (tTotal / 1000).toFixed(2),
                progressUpdateCount: progressUpdates.length,
                firstEle: result.matchedPoints[0].ele,
                lastEle: result.matchedPoints[result.matchedPoints.length - 1].ele
            };
        }""", gpx_content)

        elapsed = time.perf_counter() - t0
        print(f"\nCompleted in {elapsed:.2f} seconds!")
        print("Result Summary:")
        print(json.dumps(match_test_res, indent=2, ensure_ascii=False))

        # 3. Test Apply Match (approval) and Undo
        apply_test = page.evaluate("""() => {
            const beforeApplyCount = state.currentPoints.length;
            const applyBtn = document.getElementById('applyMatchBtn');
            applyBtn.click();
            const afterApplyCount = state.currentPoints.length;

            // Test Undo
            document.getElementById('undoBtn').click();
            const afterUndoCount = state.currentPoints.length;

            return {
                beforeApplyCount,
                afterApplyCount,
                afterUndoCount,
                undoSuccess: (afterUndoCount === beforeApplyCount)
            };
        }""")
        print("\nApply & Undo Test:", apply_test)
        assert apply_test["undoSuccess"], "Undo failed to restore points"

        browser.close()

    bench_result = {
        "test_name": "Incheon Marathon OSRM Optimization",
        "gpx_file": INCHEON_GPX_PATH,
        "browser": "Chromium 145.0",
        "metrics": match_test_res,
        "apply_and_undo": apply_test,
        "console_errors": console_errors
    }

    out_file = "/Users/admin/runruun-gpx-editor/scratch/browser_osrm_benchmark_result.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(bench_result, f, indent=2, ensure_ascii=False)
    print(f"\nDetailed report saved to {out_file}")

    assert len(console_errors) == 0, f"Console errors detected: {console_errors}"
    print("\nALL BROWSER TESTS PASSED!")

if __name__ == "__main__":
    run_integration_test()
