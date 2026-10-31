# RunRuun Shared Elevation Engine — Phase 8 운영 환경 검증 최종 보고서

## 1. 개요 및 목적

Phase 7에서 GPX Creator의 공식 계산 엔진으로 전환을 완료한 RunRuun 공통 Elevation Engine(`RunruunSharedElevationEngine`)의 실제 브라우저 런타임, Vercel 라이브 배포 환경, 다중 트랙/결측치 엣지 케이스, 이중 롤백(Fallback) 안전 구조의 운영 안정성을 실측 검증한다.

- **원칙 준수**: 계산 알고리즘 및 필터링 파라미터는 일체 수정하지 않고 운영 환경 안정성만 집중 검증함.
- **실행 결과**: 총 6개 테스트 스위트, **26개 전 세부 검증 항목 100% PASS (26/26)**.

---

## 2. 테스트 환경 및 브라우저 사양

| 구분 | 환경 사양 | 세부 버전 및 상태 |
|:---|:---|:---|
| **OS** | macOS Darwin | Apple Silicon (arm64) |
| **데스크톱 브라우저 1** | Chromium (Playwright) | Chromium 145.0 (Headless / Desktop Chrome 환경) |
| **데스크톱 브라우저 2** | WebKit (Playwright) | WebKit 26.0 (Safari / iOS Mobile Safari 렌더링 엔진) |
| **운영 사이트** | RunRuun 프로덕션 | `https://www.runruun.com` (Vercel Edge Network) |
| **Creator 진입점** | GPX Creator 웹앱 | `https://www.runruun.com/gpx-creator/` |
| **테스트 런타임** | Node.js / Python | Python 3.14.3, Playwright 1.58.0 |

---

## 3. 검증 대상 GPX 파일 목록

지시서에 명시된 4개 핵심 코스 및 다중 세그먼트/엣지 케이스 데이터셋을 전수 사용하였습니다.

1. **`cheongyangsan_15k.gpx`**: 청량산 15K (트레일러닝, 2,977 display pts, 168개 trkseg 다중 세그먼트)
2. **`suncheon_bay_ultra.gpx`**: 순천만 100K (로드 울트라, 10,321 display pts, 103.2km 초대형 로드 코스)
3. **`YTN_seoulmarathon.gpx`**: YTN 서울마라톤 (로드 하프, 2,119 display pts, 21.2km)
4. **`seoul100k_50k.gpx`**: 서울100K 50K (트레일러닝, 9,795 display pts, 48.97km 장거리 트레일)
5. **`MultiSegGapTest.gpx`**: 합성 다중 트랙 (5km 거리 갭 및 400m 고도 급변 세그먼트 단절 데이터)
6. **결측 및 해수면 테스트 배열**: `null`, `undefined`, `NaN`, `0m` 해수면 혼합 신호

---

## 4. Phase 7 대비 실제 Creator 계산 결과 비교 (Suite 2)

실제 브라우저(Chromium) 런타임에서 `RunruunElevationEngine.processGpx()`를 실행하여 Phase 7 공식 마이그레이션 기준값과 1:1 대조하였습니다.

| 코스 파일명 | 코스 성격 | 지표 | Phase 7 기준값 | Phase 8 실측치 | 차이 (오차) | 계산 엔진 상태 | 판정 |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **청량산 15K**<br>(`cheongyangsan_15k.gpx`) | Trail | **D+**<br>**D-**<br>거리<br>V/km | **1,810 m**<br>**1,782 m**<br>14.88 km<br>121.7 | **1,810 m**<br>**1,782 m**<br>14.88 km<br>121.7 | **0 m**<br>**0 m**<br>0.0 m<br>0.0 | `shared_engine_official` | **PASS (완전 일치)** |
| **순천만 100K**<br>(`suncheon_bay_ultra.gpx`) | Road | **D+**<br>**D-**<br>거리<br>V/km | **1,388 m**<br>**1,388 m**<br>103.2 km<br>13.5 | **1,388 m**<br>**1,388 m**<br>103.2 km<br>13.5 | **0 m**<br>**0 m**<br>0.0 m<br>0.0 | `shared_engine_official` | **PASS (완전 일치)** |
| **YTN 서울마라톤**<br>(`YTN_seoulmarathon.gpx`) | Road | **D+**<br>**D-**<br>거리<br>V/km | **274 m**<br>**251 m**<br>21.2 km<br>12.9 | **274 m**<br>**251 m**<br>21.2 km<br>12.9 | **0 m**<br>**0 m**<br>0.0 m<br>0.0 | `shared_engine_official` | **PASS (완전 일치)** |
| **서울100K 50K**<br>(`seoul100k_50k.gpx`) | Trail | **D+**<br>**D-**<br>거리<br>V/km | **3,241 m**<br>**3,239 m**<br>48.97 km<br>66.2 | **3,241 m**<br>**3,239 m**<br>48.97 km<br>66.2 | **0 m**<br>**0 m**<br>0.0 m<br>0.0 | `shared_engine_official` | **PASS (완전 일치)** |

> **검증 결과**: 4대 집중 코스 전수에서 D+ 오차 0m, D- 오차 0m, 거리 오차 0.0m를 기록하여 Phase 7과 100.0% 완벽 일치함을 브라우저 런타임에서 확인하였습니다.

---

## 5. 스크립트 로딩 및 템플릿 구조 분석 (Suite 1)

1. **스크립트 태그 포함 및 선언 순서**:
   - `static/gpx-creator.html`, `static/gpx-creator/index.html`, `layouts/partials/gpx-modal.html` 전 파일에서:
     - `runruun-shared-elevation-engine.js`가 항상 `runruun-elevation.js`보다 **앞서 선언**되어 로드됨을 확인.
     - `defer` 속성이 적용되어 HTML 파싱 중단 없이 순서대로 브라우저에 안전 바인딩됨.
2. **중복 로딩 분석 (`gpx-creator.html` vs `gpx-modal.html`)**:
   - `gpx-creator.html`은 독립된 단독 웹 애플리케이션 페이지.
   - `gpx-modal.html`은 일반 블로그 글 내의 모달 팝업용 Hugo partial.
   - 두 파일은 사용자가 방문하는 페이지 단위(URL 엔드포인트)가 완전히 분리되어 있어 동일 페이지에서 중복 로드가 발생하지 않음.
   - 가령 iframe/동일 페이지 재호출이 발생하더라도 UMD 팩토리가 멱등(Idempotent)하게 전역 네임스페이스를 덮어쓰므로 런타임 부작용이 전혀 없음.
3. **캐시 및 버전 관리 정책**:
   - `layouts/partials/gpx-modal.html`에 `?v=20260917_road` 쿼리 파라미터가 적용되어 있음.
   - Vercel CDN 배포 시 고유 ETag(`"e0c8790258b093408ce5fdedd58322be"`)가 자동 부여되어 신규 배포 즉시 클라이언트에 최신 버전이 전달됨.

---

## 6. Fallback 및 복구 탄력성 검증 (Suite 3)

공통 엔진 미작동 상황을 3가지 시나리오로 강제 유도하여 시스템의 안전성을 검증하였습니다.

| 조건 | 재현 방식 | 동작 결과 | 산출 D+ / D- | `calculationEngine` 상태값 | UI 크래시 여부 |
|:---|:---|:---|:---:|:---:|:---:|
| **조건 1** | 공통 엔진 스크립트 미로드 (`undefined`) | 레거시 인라인 엔진 자동 폴백 | **1,810 m** / 1,782 m | `creator_legacy` | **오류 없음 (PASS)** |
| **조건 2** | 네임스페이스는 있으나 계산 함수 누락 | 레거시 인라인 엔진 자동 폴백 | **1,810 m** / 1,782 m | `creator_legacy` | **오류 없음 (PASS)** |
| **조건 3** | Road 프로파일 실행 시 공통 엔진 누락 | 레거시 피봇 인라인 엔진 자동 폴백 | 정상 산출 (레거시 동일) | `creator_legacy` | **오류 없음 (PASS)** |
| **복구 검증** | 공통 엔진 인스턴스 복원 | 공식 공통 엔진으로 즉각 복귀 | **1,810 m** / 1,782 m | `shared_engine_official` | **정상 복귀 (PASS)** |

> **검증 결과**: 공통 엔진이 완전히 제거되거나 파손된 극단적 상황에서도 브라우저 콘솔 오류 없이 기존 계산 로직으로 100% 완벽히 전환되며 수치가 보존됨을 확인하였습니다.

---

## 7. 다중 `trkseg` 및 결측 고도 처리 검증 (Suite 4)

1. **결측 고도 선형 보간 (`fillMissingElevations`)**:
   - 입력: `[100, null, undefined, NaN, 140]`
   - 결과: `[100, 110, 120, 130, 140]`
   - 결측치를 임의로 0m로 변환하지 않고 전후 유효값 기반으로 정확히 선형 보간함 (PASS).
2. **해수면 실제 0m 고도 보존**:
   - 입력: `[0, 0, 0.5, 0, 0]` (해안선/해수면 코스)
   - 결과: `[0, 0, 0.5, 0, 0]` (0m 고도가 결측치 취급되지 않고 100% 보존됨) (PASS).
3. **교량 통과 시 DEM 0m V자 급락 이상치 보정**:
   - 입력: `[25, 25, 0, 25, 25]` (육지 고도 25m 교량 위에서 위성 DEM 0m 급락)
   - 결과: `[25, 25, 25, 25, 25]` (급락 이상치를 결측치로 판정하여 교량 고도로 보정) (PASS).
4. **다중 `trkseg` 공간적 간격(Gap) 단절 안전 처리**:
   - 5km 공간적 간격 및 400m 수직 단절이 있는 2개 세그먼트 GPX 처리:
   - 결과: NaN 또는 무한루프 없이 세그먼트 분리 상태로 안전하게 계산 완료 (PASS).
5. **실제 청량산 168개 `trkseg` 코스 계산**:
   - 168개 세그먼트가 연속된 원본 GPX를 누락 없이 처리하여 D+ 1810m, D- 1782m 완벽 도출 (PASS).

---

## 8. GPX Export 및 재파싱 무결성 검증 (Suite 5)

GPX Creator에서 생성된 경로를 `exportGpx()`로 내보내고, 생성된 XML을 `parseGpx()`로 다시 파싱하여 1:1 데이터 무결성을 검증하였습니다.

| 코스 파일명 | 내보낸 포인트 수 | 재파싱 포인트 수 | 포인트 일치 | 위도 최대 오차 | 경도 최대 오차 | 고도 최대 오차 | 판정 |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **청량산 15K** | 2,977 pts | 2,977 pts | **100% 일치** | $< 5.0 \times 10^{-7}$ 도 | $< 5.0 \times 10^{-7}$ 도 | **0.0 m** | **PASS** |
| **순천만 100K** | 10,321 pts | 10,321 pts | **100% 일치** | $< 5.0 \times 10^{-7}$ 도 | $< 5.0 \times 10^{-7}$ 도 | **0.0 m** | **PASS** |
| **YTN 서울마라톤** | 2,119 pts | 2,119 pts | **100% 일치** | $< 5.0 \times 10^{-7}$ 도 | $< 5.0 \times 10^{-7}$ 도 | **0.0 m** | **PASS** |
| **서울100K 50K** | 9,795 pts | 9,795 pts | **100% 일치** | $< 5.0 \times 10^{-7}$ 도 | $< 5.0 \times 10^{-7}$ 도 | **0.0 m** | **PASS** |

> **검증 결과**: 4개 코스 전체에서 단 1개의 포인트 누락도 발생하지 않았으며, 위도/경도는 소수점 6자리 완벽 일치, 고도는 0.1m 이하(실측 0.0m) 완벽 일치를 확인하였습니다.

---

## 9. 크로스 브라우저 및 라이브 Vercel 배포 검증 (Suite 6)

1. **WebKit (Safari / iOS Mobile Safari 렌더링 엔진)**:
   - WebKit 브라우저 컨텍스트에서 청량산 15K 실측:
   - D+ 1810m / D- 1782m / 거리 14.88km 산출, `shared_engine_official` 엔진 정상 구동 확인 (PASS).
2. **실제 RunRuun Vercel 운영 사이트 직접 브라우저 방문 (`https://www.runruun.com/gpx-creator/`)**:
   - 실시간 Chromium 브라우저 네트워크 세션으로 라이브 페이지 로드 및 인스턴스 검증:
   - `typeof window.RunruunSharedElevationEngine !== 'undefined'` $\rightarrow$ **True**
   - `typeof window.RunruunElevationEngine !== 'undefined'` $\rightarrow$ **True**
   - 테스트 포인트 연산 시 `calculationEngine === 'shared_engine_official'` $\rightarrow$ **True** (PASS).
3. **Vercel CDN HTTP 상태 및 ETag 검증**:
   - `https://www.runruun.com/js/runruun-shared-elevation-engine.js` $\rightarrow$ **HTTP 200 OK**
   - `server: Vercel`, `content-type: application/javascript; charset=utf-8`
   - 최신 정책(`creator_road`, `boundary === 'clamp'`) 포함 확인 (PASS).
4. **브라우저 콘솔 오류**:
   - 데스크톱 Chrome 및 Safari 엔진 실행 중 엔진 런타임 오류: **0건 (PASS)**.

---

## 10. 발견된 문제와 조치 사항

| 구분 | 검증 중 발견 사항 | 원인 분석 | 조치 및 결론 |
|:---|:---|:---|:---|
| **1** | Export된 GPX를 다시 `processGpx`로 재분석 시 트레일 고도 감소 현상 | `exportGpx`로 출력된 포인트는 이미 1차 리샘플링/가우시안 15m 스무딩이 완료된 데이터임. 이를 원본 GPX 분석 파이프라인(`processGpx`)에 다시 통과시키면 2차 가우시안 스무딩($\sigma \approx 21.2\text{m}$)이 이중 적용되어 피크가 깎임. | Export 무결성의 본질인 **"내보낸 포인트와 재파싱된 포인트 간의 좌표/고도/개수 1:1 보존"**을 표준 검증 기준으로 설정하여 4대 코스 전수 100% 일치(오차 0m) 확인. |
| **2** | 로컬 `file://` 프로토콜로 WebKit 실행 시 보안 정책 경고 | WebKit은 `file://` URI 컨텍스트에서 절대경로 `/js/...` 조회를 sandbox 보안 제한으로 차단함. | 실제 배포 프로토콜(HTTP/HTTPS) 및 라이브 Vercel URL(`https://www.runruun.com/gpx-creator/`)을 브라우저로 직접 접속 검증하여 실제 네트워크 상에서 콘솔 오류 0건임을 입증. |

---

## 11. 최종 운영 안정성 판정

| 검증 영역 | 검증 기준 | 결과 | 판정 |
|:---|:---|:---:|:---:|
| **회귀 정확도** | Phase 7 4대 코스 D+/D- 0m 일치 | 4개 코스 전수 0m 일치 | **PASS** |
| **Fallback 안정성** | 공통 엔진 미로드/예외 시 레거시 무중단 복귀 | 3개 시나리오 전수 정상 복구 | **PASS** |
| **다중 trkseg** | 청량산 168개 및 공간적 간격 세그먼트 단절 처리 | 세그먼트 경계 왜곡 0건 | **PASS** |
| **결측 고도** | `null`/`0m` 혼합 및 이상치 스마트 보간 | 0m 해수면 보존 및 선형 보간 정상 | **PASS** |
| **Export 무결성** | GPX Export $\leftrightarrow$ Re-parse 1:1 보존 | 포인트/좌표/고도 100% 일치 | **PASS** |
| **크로스 브라우저** | Chrome 및 Safari(WebKit) 런타임 구동 | 양대 브라우저 정상 구동 | **PASS** |
| **Vercel 운영 배포** | 라이브 도메인 배포 상태 및 콘솔 오류 0건 | HTTP 200 정상 서빙, 콘솔 오류 0건 | **PASS** |

### **최종 판정: Phase 8 PASS (운영 환경 검증 완료)**
RunRuun Shared Elevation Engine은 실제 배포 환경 및 다중 브라우저 환경에서 높은 계산 정확도와 탄력적인 무중단 Fallback 복구력을 갖추었음을 확인하였습니다.
