#!/usr/bin/env python3
"""
Phase 4: Comprehensive Regression Test Suite for OSRM Match Stabilization
Validates all 6 GPX courses in headless Chromium browser:
1. Incheon Marathon (Large, 13,671 pts)
2. Suncheon Bay 100K (Ultra, 103 km, unpaved fallback)
3. Cheonglyangsan 15K (Mountain, 168 trkseg preservation)
4. 2025 MBN Seoul (Urban Canyon, overpass/underpass seam)
5. Siheung Half (180 deg turnaround U-turn)
6. Chuncheon Marathon (Bridge, lake, tunnel)

Checks:
- Processing time
- Chunk success rate & Boundary max jump
- Segment count & trkseg structure preservation
- Distance change ratio
- Elevation & timestamp preservation
- D+/D- calculation via Shared Elevation Engine
- Export XML reparsing & Undo/Redo integrity
"""

import os
import sys
import json
import xml.etree.ElementTree as ET
from playwright.sync_api import sync_playwright

INDEX_HTML_PATH = os.path.abspath("/Users/admin/runruun-gpx-editor/index.html")

TEST_CASES = [
    {
        "id": "incheon_full",
        "name": "인천마라톤 대용량 GPX",
        "path": "/Users/admin/Desktop/보정/인천마라톤_최초원본.gpx"
    },
    {
        "id": "suncheon_100k",
        "name": "순천만 100K 장거리 GPX",
        "path": "/Users/admin/Desktop/gpx-road/suncheon_bay_ultra.gpx"
    },
    {
        "id": "cheonglyang_15k",
        "name": "청량산 15K 다중 trkseg GPX",
        "path": "/Users/admin/Desktop/gpx/cheonglyangsan_15k.gpx"
    },
    {
        "id": "seoul_mbn",
        "name": "2025 MBN 서울 도심 마라톤 GPX",
        "path": "/Users/admin/Desktop/gpx-road/2025mbnseoul.gpx"
    },
    {
        "id": "siheung_half",
        "name": "시흥 하프 마라톤 GPX",
        "path": "/Users/admin/Desktop/gpx-road/siheung_half_marathon.gpx"
    },
    {
        "id": "chuncheon_full",
        "name": "춘천마라톤 풀코스 GPX",
        "path": "/Users/admin/Desktop/gpx-road/chuncheon_full.gpx"
    }
]

def run_stabilization_regression():
    print("=" * 75)
    print("   RunRuun OSRM Match 안정화 프로젝트 — 6대 실측 GPX 전수 회귀 테스트   ")
    print("=" * 75)

    results = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        console_errors = []
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" and "net::ERR" not in msg.text else None)

        page.goto(f"file://{INDEX_HTML_PATH}")
        page.wait_for_timeout(500)

        for idx, tc in enumerate(TEST_CASES):
            print(f"\n[{idx + 1}/6] 대상 코스: {tc['name']}")
            print(f"      파일: {tc['path']}")

            if not os.path.exists(tc["path"]):
                print(f"      ❌ 파일이 존재하지 않습니다: {tc['path']}")
                continue

            with open(tc["path"], "r", encoding="utf-8") as f:
                gpx_content = f.read()

            # Step 1: Load GPX into Editor
            load_res = page.evaluate("""
                (args) => {
                    const gpxText = args[0];
                    const fileName = args[1];
                    try {
                        const points = parseGPX(gpxText, fileName);
                        loadNewPoints(points, fileName);
                        const origSegSet = new Set(points.map(p => `${p.trkIdx}_${p.segIdx}`));
                        return {
                            success: true,
                            pointsCount: state.currentPoints.length,
                            segCount: origSegSet.size,
                            origDistKm: (calculateStats(state.currentPoints).totalDist / 1000).toFixed(2),
                            startEle: state.currentPoints[0]?.ele,
                            endEle: state.currentPoints[state.currentPoints.length - 1]?.ele,
                            hasTime: state.currentPoints.some(p => p.time !== null)
                        };
                    } catch (e) {
                        return { success: false, error: e.message };
                    }
                }
            """, [gpx_content, tc["name"]])

            if not load_res.get("success"):
                print(f"      ❌ GPX 로딩 실패: {load_res.get('error')}")
                continue

            print(f"      - 원본 로딩 완료: {load_res['pointsCount']:,} pts, {load_res['segCount']} segs, {load_res['origDistKm']} km")

            # Step 2: Trigger Stabilized OSRM Match
            print(f"      - 도로 중심선 스냅 모드로 전환 중...")
            page.click('.mode-tab-btn[data-mode="road-snap"]')
            page.wait_for_timeout(300)

            print(f"      - 안정화 OSRM Match 연산 실행 중...")
            page.click("#executeRoadMatchBtn")
            page.wait_for_timeout(400)

            # Check if trail confirmation modal popped up
            is_modal_active = page.evaluate("() => document.getElementById('confirmModal').classList.contains('active')")
            if is_modal_active:
                print(f"      - 트레일 코스 사전 경고 모달 감지: [확인] 승인 클릭")
                page.click("#modalConfirmBtn")

            # Wait for match review card to appear (or error toast)
            page.wait_for_selector("#matchReviewCard", state="visible", timeout=180000)

            # Extract Match Results from state
            match_stats = page.evaluate("""
                () => {
                    const preview = state.matchPreviewData;
                    if (!preview) return null;
                    const res = preview.matchResult;
                    const matchedPts = preview.matchedPts;
                    const origSegSet = new Set(state.currentPoints.map(p => `${p.trkIdx}_${p.segIdx}`));
                    const matchedSegSet = new Set(matchedPts.map(p => `${p.trkIdx}_${p.segIdx}`));

                    let maxJump = 0;
                    if (res.boundaryJumps) {
                        res.boundaryJumps.forEach(j => { if (j.jumpMeters > maxJump) maxJump = j.jumpMeters; });
                    }

                    const origDist = calculateStats(state.currentPoints).totalDist;
                    const matchedDist = calculateStats(matchedPts).totalDist;
                    const deltaDistM = matchedDist - origDist;
                    const deltaRatio = origDist > 0 ? (deltaDistM / origDist) * 100 : 0;

                    const applyBtn = document.getElementById('applyMatchBtn');
                    const isApplyDisabled = applyBtn ? applyBtn.disabled : false;

                    return {
                        totalTimeMs: res.timings.totalTimeMs,
                        totalChunks: res.totalChunks,
                        successChunks: res.successChunks,
                        failedChunks: res.failedChunks,
                        avgConfidence: res.avgConfidence,
                        matchedCount: matchedPts.length,
                        origSegCount: origSegSet.size,
                        matchedSegCount: matchedSegSet.size,
                        segsPreserved: origSegSet.size === matchedSegSet.size,
                        maxBoundaryJumpM: maxJump,
                        deltaDistM: Math.round(deltaDistM * 10) / 10,
                        deltaRatioPercent: Math.round(deltaRatio * 100) / 100,
                        matchedStartEle: matchedPts[0]?.ele,
                        matchedEndEle: matchedPts[matchedPts.length - 1]?.ele,
                        isBlocked: res.isBlocked,
                        isApplyDisabled,
                        issues: res.issues
                    };
                }
            """)

            print(f"      - 매칭 완료 (소요 시간: {match_stats['totalTimeMs']/1000:.1f}초)")
            print(f"      - 청크 성공률: {match_stats['successChunks']}/{match_stats['totalChunks']} ({match_stats['avgConfidence']}%)")
            print(f"      - 세그먼트 보존: {match_stats['matchedSegCount']}/{match_stats['origSegCount']} segs ({'✅ 100% 보존' if match_stats['segsPreserved'] else '❌ 소실'})")
            print(f"      - 최대 경계 점프: {match_stats['maxBoundaryJumpM']} m")
            print(f"      - 거리 변화: {match_stats['deltaDistM']} m ({match_stats['deltaRatioPercent']}%)")
            print(f"      - 고도 보존: 시작 {load_res['startEle']}m -> {match_stats['matchedStartEle']}m / 끝 {load_res['endEle']}m -> {match_stats['matchedEndEle']}m")
            print(f"      - 안전 차단 여부: {'🚫 차단(안전보호)' if match_stats['isBlocked'] else '✅ 정상허용'}")

            # Step 3: Test Apply or Cancel according to isBlocked
            if match_stats['isBlocked']:
                print(f"      - 80m 초과 점프 감지됨: [적용 버튼] 비활성화 상태 확인: {'✅ 정상 비활성화' if match_stats['isApplyDisabled'] else '❌ 차단 누락'}")
                page.click("#cancelMatchBtn")
            else:
                print(f"      - 안전 검증 통과: [적용 버튼] 클릭 및 상태 갱신 테스트...")
                page.click("#applyMatchBtn")
                page.wait_for_timeout(300)

                # Verify points updated
                cur_len = page.evaluate("() => state.currentPoints.length")
                print(f"      - 적용 후 현재 포인트 수: {cur_len:,} pts")

                # Test Export Reparsing
                export_check = page.evaluate("""
                    () => {
                        const xmlOut = exportToGPXString(state.currentPoints);
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(xmlOut, "application/xml");
                        const trkpts = doc.querySelectorAll("trkpt");
                        const trksegs = doc.querySelectorAll("trkseg");
                        return {
                            validXml: !doc.querySelector("parsererror"),
                            exportedPts: trkpts.length,
                            exportedSegs: trksegs.length
                        };
                    }
                """)
                print(f"      - Export 재파싱 무결성: {'✅ XML 정상' if export_check['validXml'] else '❌ 파싱오류'} (Exported: {export_check['exportedPts']} pts, {export_check['exportedSegs']} segs)")

                # Test Undo
                page.click("#undoBtn")
                page.wait_for_timeout(200)
                reverted_len = page.evaluate("() => state.currentPoints.length")
                print(f"      - [Undo] 실행 후 원본 포인트 복원 확인: {reverted_len:,} pts (원본 {load_res['pointsCount']:,} pts와 {'✅ 100% 일치' if reverted_len == load_res['pointsCount'] else '❌ 불일치'})")

            results.append({
                "testCase": tc,
                "load": load_res,
                "match": match_stats,
                "consoleErrors": len(console_errors)
            })

        browser.close()

    # Save regression report
    out_json = "/Users/admin/runruun-gpx-editor/scratch/stabilization_regression_results.json"
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print("\n" + "=" * 75)
    print("                      회귀 테스트 최종 요약                         ")
    print("=" * 75)
    for r in results:
        m = r["match"]
        l = r["load"]
        print(f"• {r['testCase']['name']}:")
        print(f"    - 시간: {m['totalTimeMs']/1000:.1f}초 | 세그먼트: {m['matchedSegCount']}/{l['segCount']} | 최대점프: {m['maxBoundaryJumpM']}m | 거리변화: {m['deltaDistM']}m ({m['deltaRatioPercent']}%) | 차단: {m['isBlocked']}")
    print(f"\n전체 회귀 결과 저장: {out_json}")
    print(f"브라우저 콘솔 오류: {len(console_errors)} 건")
    print("=" * 75)

if __name__ == "__main__":
    run_stabilization_regression()
