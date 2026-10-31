import json
from playwright.sync_api import sync_playwright

CREATOR_ENGINE_PATH = "/Users/admin/Desktop/runruun/static/js/runruun-elevation.js"
SHARED_ENGINE_PATH = "/Users/admin/runruun-gpx-editor/runruun-shared-elevation-engine.js"
CREATOR_HTML_PATH = "/Users/admin/Desktop/runruun/static/gpx-creator/index.html"

def run_deep_dive():
    results = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(f"file://{CREATOR_HTML_PATH}")
        page.add_script_tag(path=SHARED_ENGINE_PATH)
        page.add_script_tag(path=CREATOR_ENGINE_PATH)

        courses = [
            ("/Users/admin/Desktop/gpx-road/suncheon_bay_ultra.gpx", "suncheon_bay_ultra", "순천만 100K"),
            ("/Users/admin/Desktop/gpx-road/YTN_seoulmarathon.gpx", "YTN_seoulmarathon", "YTN 서울마라톤")
        ]

        for gpx_file, key, name in courses:
            with open(gpx_file, "r", encoding="utf-8") as f:
                content = f.read()

            res = page.evaluate("""(gpx) => {
                const rawPts = RunruunElevationEngine.parseGpx(gpx);
                
                // 1. Raw cumulative distance
                const c_dist = [0];
                let c_acc = 0;
                for (let i = 1; i < rawPts.length; i++) {
                    c_acc += RunruunElevationEngine.haversineDistanceMeters(rawPts[i-1].lat, rawPts[i-1].lon, rawPts[i].lat, rawPts[i].lon);
                    c_dist.push(c_acc);
                }
                const s_dist = RunruunSharedElevationEngine.calculateCumulativeDistances(rawPts);

                // 2. 10m Resampling
                const c_resample = RunruunElevationEngine.resamplePoints(rawPts, 10.0);
                const s_resample = RunruunSharedElevationEngine.resamplePoints(rawPts, 10.0);

                // 3. 15% Spike limiter
                const c_spike = RunruunElevationEngine.limitGradientSpikes(c_resample, 0.15);
                const s_spike = RunruunSharedElevationEngine.limitGradientSpikes(s_resample, 0.15);

                // 4. Gaussian 60m
                const c_gauss = RunruunElevationEngine.spatialGaussianSmooth(c_spike, 60.0, 10.0);
                const s_gauss = RunruunSharedElevationEngine.spatialGaussianSmooth(s_spike, 60.0, 10.0);

                // 5. Pivot calculation
                const c_calc = RunruunElevationEngine.calculateElevationGainLoss(c_gauss, 3.0);
                const s_calc = RunruunSharedElevationEngine.accumulateCreatorPivot(s_gauss, 3.0);

                // Compare elements across steps
                // Check sample at boundaries and sample differences
                const resampleDiffCount = Math.abs(c_resample.length - s_resample.length);
                const gaussDiffs = [];
                for (let i = 0; i < Math.min(c_gauss.length, s_gauss.length); i++) {
                    const diff = Math.abs(c_gauss[i].ele - s_gauss[i].ele);
                    if (diff > 0.05) {
                        gaussDiffs.push({ idx: i, dist: c_gauss[i].dist, c_ele: c_gauss[i].ele, s_ele: s_gauss[i].ele, diff: Math.round(diff * 100) / 100 });
                    }
                }

                return {
                    rawCount: rawPts.length,
                    totalDistMeters: { creator: c_acc, shared: s_dist[s_dist.length - 1] },
                    resampleCount: { creator: c_resample.length, shared: s_resample.length },
                    c_resample_tail: c_resample.slice(-4).map(p => ({ dist: p.dist, ele: p.ele })),
                    s_resample_tail: s_resample.slice(-4).map(p => ({ dist: p.dist, ele: p.ele })),
                    gaussCount: { creator: c_gauss.length, shared: s_gauss.length },
                    gaussDiffsCount: gaussDiffs.length,
                    gaussDiffsSample: gaussDiffs.slice(0, 10),
                    gaussDiffsTail: gaussDiffs.slice(-10),
                    creatorGainLoss: { gain: c_calc.eleGain, loss: c_calc.eleLoss },
                    sharedGainLoss: { gain: s_calc.eleGain, loss: s_calc.eleLoss },
                    creatorPivotsCount: c_calc.pivots.length,
                    sharedPivotsCount: s_calc.confirmedPivots.length,
                    creatorPivots: c_calc.pivots.map(p => ({ dist: p.dist, ele: p.ele, type: p.type, idx: p.idx })),
                    sharedPivots: s_calc.confirmedPivots.map(p => ({ dist: p.dist, ele: p.ele, type: p.type, idx: p.idx }))
                };
            }""", content)

            results[key] = {
                "name": name,
                "data": res
            }

        browser.close()

    for key, item in results.items():
        name = item["name"]
        d = item["data"]
        print(f"\n==========================================")
        print(f"Course: {name} ({key})")
        print(f"Raw points: {d['rawCount']}")
        print(f"Total distance: Creator={d['totalDistMeters']['creator']:.3f}m, Shared={d['totalDistMeters']['shared']:.3f}m")
        print(f"Resample count: Creator={d['resampleCount']['creator']}, Shared={d['resampleCount']['shared']}")
        print(f"Creator tail resample: {d['c_resample_tail']}")
        print(f"Shared tail resample: {d['s_resample_tail']}")
        print(f"Gaussian smoothed diffs count (>0.05m): {d['gaussDiffsCount']} out of {d['gaussCount']['creator']}")
        print(f"Gaussian diffs head: {d['gaussDiffsSample'][:3]}")
        print(f"Gaussian diffs tail: {d['gaussDiffsTail'][-3:]}")
        print(f"Creator Pivots: {d['creatorPivotsCount']}, Shared Pivots: {d['sharedPivotsCount']}")
        print(f"Creator D+/D-: {d['creatorGainLoss']['gain']}m / {d['creatorGainLoss']['loss']}m")
        print(f"Shared D+/D-: {d['sharedGainLoss']['gain']}m / {d['sharedGainLoss']['loss']}m")

        # Pivot differences analysis
        cp = d["creatorPivots"]
        sp = d["sharedPivots"]
        print(f"Pivot detail compare:")
        p_diffs = []
        for i in range(max(len(cp), len(sp))):
            c_p = cp[i] if i < len(cp) else None
            s_p = sp[i] if i < len(sp) else None
            if c_p is None or s_p is None:
                p_diffs.append((i, c_p, s_p, "LENGTH_MISMATCH"))
            elif abs(c_p["ele"] - s_p["ele"]) > 0.05 or abs(c_p["dist"] - s_p["dist"]) > 0.05 or c_p["type"] != s_p["type"]:
                p_diffs.append((i, c_p, s_p, "VALUE_MISMATCH"))

        print(f"Total mismatched pivots: {len(p_diffs)}")
        for i, c_p, s_p, reason in p_diffs[:8]:
            print(f"  Pivot #{i} [{reason}]: Creator={c_p} vs Shared={s_p}")

    with open("/Users/admin/runruun-gpx-editor/scratch/deep_dive_results.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

if __name__ == "__main__":
    run_deep_dive()
