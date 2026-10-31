# RunRuun GPX Editor 1단계(실제 지도 타일 연결) 테스트 보고서

- **검증 일시:** 2026-10-31
- **기준 커밋:** `1ac6c3a`
- **검증 환경:** Leaflet 1.9.4, Python 3.14 (Playwright E2E 자동화 엔진), Chromium 브라우저
- **대상 저장소:** `zohoda-ui/runruun-gpx-editor`

---

## 1. 1단계 개발 요구사항 및 구현 내역

### 1.1 Leaflet 1.9.4 & OpenStreetMap 기본 레이어 연결
- **Leaflet 버전:** 1.9.4 CSS 및 JS CDN 연동
- **기본 타일 레이어:** `OpenStreetMap (표준)` (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`)
- **Attribution 표기:** `&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors` 등 각 지도 제공자별 저작권 규정 준수
- **추가 지도 레이어:**
  - `CartoDB Dark Matter (다크)`
  - `CartoDB Positron (라이트)`
  - `OpenTopoMap (등고선/지형)`
- **타일 로딩 실패 처리:** `tileerror` 이벤트 리스너를 통한 자동 상태 감지 및 지도 상단 경고 배너(`mapTileErrorBanner`), 토스트 알림 연동

### 1.2 경로 스타일 및 마커 가시성
- **원본 경로:** **회색 점선** (`color: #9ca3af`, `weight: 3`, `dashArray: '6, 8'`, `opacity: 0.85`)
- **수정 경로:** **녹색 실선** (`color: #10b981`, `weight: 4`, `opacity: 0.95`)
- **출발점 마커:** 녹색 원형 뱃지 `S` (Start: #1) 전용 마커 (툴팁 및 그림자 효과)
- **도착점 마커:** 빨간색 원형 뱃지 `F` (Finish: #N) 전용 마커 (툴팁 및 그림자 효과)
- **선택 포인트:** 하늘색 펄싱 드래그 마커 및 폼 실시간 위도/경도 연동

### 1.3 지도 클릭 포인트 추가 모드
- **토글 버튼:** 지도 상단 플로팅 툴바의 `[지도 클릭 추가]` 버튼 (`#toggleMapAddModeBtn`)
- **인터랙션:** 모드 활성화 시 지도 커서가 `crosshair`로 변경되며, 지도 임의 지점 클릭 시 인접 고도 선형 보간을 반영한 새 트랙 포인트 자동 삽입 및 선택
- **실수 방지:** 일반 모드에서는 반경 100m 이내 포인트 선택만 수행하여 지도 탐색 시 오작동 원천 차단

### 1.4 반응형 모바일/데스크톱 레이어
- 900px 이하 모바일/태블릿 화면을 위한 반응형 미디어 쿼리 탑재 (사이드바 및 지도 상하 분할 스크롤 지원)

---

## 2. 1단계 정밀 실측 검증 결과 (PASS / FAIL)

| 검증 항목 | 대상 데이터 / 테스트 항목 | 실측 측정값 및 동작 | 결과 |
| :--- | :--- | :--- | :---: |
| **기본 타일 레이어** | OpenStreetMap Standard | 기본 선택값 `osm-standard`, OSM 타일 정상 요청 | **PASS** |
| **Attribution 표기** | Leaflet Attribution Control | `© OpenStreetMap contributors` 정상 렌더링 | **PASS** |
| **서울 시내 GPX** | `YTN_seoulmarathon.gpx` | 2,410 pts, 21.18 km, 지도 Bounds 정상 맞춤 | **PASS** |
| **대구 시내 GPX** | `daegu_marathon.gpx` | 8,522 pts, 42.41 km, 지도 Bounds 정상 맞춤 | **PASS** |
| **청량산 트레일 GPX** | `cheonglyangsan_15k.gpx` | 11,401 pts, 14.88 km, 고지대 트랙 정상 표시 | **PASS** |
| **100km+ 장거리 GPX** | `suncheon_bay_ultra.gpx` | 3,902 pts, 103.20 km, 초장거리 광역 지도 표시 | **PASS** |
| **출발(S)/도착(F) 마커** | 샘플 및 실제 코스 전체 | 녹색 S 마커, 빨간색 F 마커 1:1 개별 표시 | **PASS** |
| **경로 오버레이 스타일** | 원본 / 수정본 라인 | 원본 회색 점선(`#9ca3af`), 수정 녹색 실선(`#10b981`) | **PASS** |
| **포인트 선택 및 드래그** | 지도 상 인터랙티브 마커 | 마우스 드래그 좌표 이동 및 실시간 폼 반영 확인 | **PASS** |
| **지도 클릭 포인트 추가** | 클릭 추가 모드 활성화 상태 | 지도 클릭 즉시 새 포인트 삽입 (14pts -> 15pts) | **PASS** |
| **지도 레이어 실시간 전환** | Carto Dark / OpenTopoMap | 타일 URL 즉시 변경 및 지형 등고선 표출 | **PASS** |
| **전체 코스 뷰 맞춤** | `fitBoundsBtn` | 클릭 시 전체 코스 영역 바운즈로 줌/중심 정렬 | **PASS** |
| **원본 GPX 불변성** | 4종 실제 GPX 파일 | SHA-256 해시 검증 100% 일치 (읽기 전용 보장) | **PASS** |

---

## 3. 원본 GPX 파일 무결성 실측 (SHA-256)

외부 원본 파일은 테스트 중 절대 수정되거나 덮어쓰이지 않았으며, 테스트 전후 SHA-256 해시값이 100% 일치합니다.

1. `YTN_seoulmarathon.gpx`: `2b4e5731998114cfb1532cf41604c66645b44919b7a543b459f687a802a1ced8` (일치)
2. `daegu_marathon.gpx`: `ad43d93f97250328f5742fa5eaf7883b99d573206e65e6213157c8f6b8fd6d5f` (일치)
3. `cheonglyangsan_15k.gpx`: `f43f5b5292b4ea3a35412204b1d50cfe0db3831d810e24b286adb124bfcedd07` (일치)
4. `suncheon_bay_ultra.gpx`: `eb84f263fcc2d98d7b70f3bb3126271d34c216664e85dce6dc0a523b6fe06708` (일치)

---

## 4. 결론

1단계 개발 지시서의 모든 요구사항(Leaflet 1.9.4 연결, OpenStreetMap 기본 레이어 설정, 회색 점선/녹색 실선 경로 오버레이, 출발(S)/도착(F) 마커, 지도 클릭 포인트 추가 모드, 모바일 반응형 디자인, 4종 실제 코스 표시)이 정상 작동함을 실측 검증 완료하였습니다.
