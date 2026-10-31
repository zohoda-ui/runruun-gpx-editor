# RunRuun GPX Creator / GPX Editor 공통 엔진 사용 여부 정밀 분석 보고서

## 1. 개요 및 목적

본 보고서는 **RunRuun GPX Creator**와 **RunRuun GPX Editor**의 소스 코드 및 동작 메커니즘을 비교 분석하여, 두 시스템이 동일한 GPX 처리 엔진을 공유하고 있는지 또는 독립된 별도의 엔진을 사용하고 있는지를 분석한 결과를 제공합니다.

> [!NOTE]
> 본 작업은 **분석 및 실측 검증만 수행**하였으며, 기존 GPX Creator, GPX Editor 및 원본 GPX 파일에 대한 코드 수정, 리팩터링, Git 변경 작업은 일절 수행하지 않았습니다.

---

## 2. 분석 대상 시스템 위치 및 구조

| 구분 | **RunRuun GPX Editor** | **RunRuun GPX Creator** |
|---|---|---|
| **저장소** | `zohoda-ui/runruun-gpx-editor` | `zohoda-ui/hugo_blog` (`zohoda-ui/gpx-creator`) |
| **파일 경로** | `/Users/admin/runruun-gpx-editor/index.html` | `/Users/admin/Desktop/runruun/static/gpx-creator/index.html`<br>`/Users/admin/Desktop/runruun/static/js/runruun-elevation.js` |
| **소프트웨어 성격** | 기존 GPX 파일의 정밀 편집, 도로 스냅, 고도 보정, 무결성 복원 전문 **에디터 (Editor)** | 지도 위에서 클릭하여 BRouter/OSRM으로 새 경로를 그리고 고도를 자동 생성하는 **생성기 (Creator)** |
| **엔진 아키텍처** | **단일 파일 내장 인라인 엔진 (Inlined Vanilla JS)**<br>외부 의존 라이브러리 없이 `index.html` 내에 모든 파싱·거리·고도·내보내기 로직 구현 | **외부 공통 모듈 참조 방식 (`RunruunElevationEngine`)**<br>`runruun-elevation.js` 라이브러리를 `<script>`로 로드하여 호출 |
| **공통 모듈 참조** | **미참조 (독립 구현)** | **참조 (`window.RunruunElevationEngine`)** |

---

## 3. 기능별 엔진 비교 분석 (12개 핵심 기능)

각 기능별 판정 기준:
- **SAME**: 동일한 공통 소스 파일 또는 모듈을 공유하여 사용함
- **EQUIVALENT**: 별도 구현이지만 수학적 알고리즘과 계산 결과가 동일함
- **DIFFERENT**: 구현 알고리즘, 데이터 구조, 파이프라인 또는 결과값이 상이함
- **NOT TESTED**: 검증하지 못함

### 3.1 12개 기능별 종합 대조표

| No. | 비교 기능 항목 | GPX Editor 구현 방식 | GPX Creator (`RunruunElevationEngine`) 구현 방식 | 판정 |
|:---:|---|---|---|:---:|
| 1 | **GPX 파싱 및 XML 처리** | `DOMParser` 사용, `<trk>`-`<trkseg>`-`<trkpt>` 계층 보존, `<wpt>` 독립 파싱 | `DOMParser` 파싱 후 실패 시 정규식(`parseGpxRegex`) 폴백, `trkpt`/`rtept`/`wpt`를 1개 배열로 평탄화(Flatten) | **DIFFERENT** |
| 2 | **위경도 좌표 처리** | 원본 위경도 좌표 100% 보존 편집, OSRM 매칭 스냅, 개별 포인트 좌표 수동 편집 | 5m(트레일) / 10m(로드) 간격으로 등간격 리샘플링(`resamplePoints`) 수행하여 좌표 재배열 | **DIFFERENT** |
| 3 | **거리 계산 (Distance)** | Haversine 공식 ($R=6,371,000m$) 인라인 함수 구현 | `RunruunElevationEngine.haversineDistanceMeters` ($R=6,371,000m$) 사용 | **EQUIVALENT** |
| 4 | **고도 데이터 처리** | 5종 상태 배열(`original`, `measured`, `interpolated`, `failed`, `manual`) 분리 관리 | `points[].ele` 및 `originalEle` 수치 관리, 상태 플래그 미분리 | **DIFFERENT** |
| 5 | **DEM API 조회** | **Open-Elevation API** (SRTM 30m), 대표 96개 표본 지점 1회 일괄 조회 | **Open-Meteo API** (Copernicus 30m) 기본 + **OpenTopoData** 폴백, 50개 배치 전수 조회 | **DIFFERENT** |
| 6 | **DEM 보간 (Interpolation)** | 96개 표본 사이를 누적 거리 기준 단순 **선형 보간 (Linear)** | 결측값 채움 후 **공간 가우시안 필터 (15m/60m)** 및 **경사도 스파이크 리미터 (15%/45%)** 적용 | **DIFFERENT** |
| 7 | **D+ / D- 계산** | 단순 임계값 누적 (`calculateElevationGainLoss`, 기본 threshold=0 또는 1m) | Hysteresis 상태 머신 기반 데드밴드 누적 (로드: 3m, 트레일: 1m) | **DIFFERENT** |
| 8 | **고도 필터링** | 1m 임계값 고도차 필터링 옵션 분리 지원 | 프로필 기반 공간 가우시안 스무딩 + 물리적 경사도 한계 이상치 제한 | **DIFFERENT** |
| 9 | **고도 프로파일 생성** | Chart.js 사용, 원본 및 보간 포인트 고도를 그대로 x축 거리에 렌더링 | Chart.js 사용, 가우시안 필터링이 적용된 스무딩 포인트(`displayPoints`) 렌더링 | **DIFFERENT** |
| 10 | **GPX Export** | 원본 메타데이터, 보간 안내 태그, `<wpt>`, 다중 `<trkseg>` 구조 100% 보존 출력 | 단일 `<trk>` 아래 단 1개의 `<trkseg>`만 출력, 다중 세그먼트 손실 | **DIFFERENT** |
| 11 | **다중 trkseg / wpt 보존** | `trkIdx`, `segIdx` 매핑을 통해 다중 세그먼트 및 웨이포인트 완전 보존 (청량산 168개 보존) | 단일 트랙/세그먼트로 강제 병합되어 다중 세그먼트 및 웨이포인트 속성 누락 | **DIFFERENT** |
| 12 | **Undo / Redo** | `history`, `redoStack`, `restoreOriginalElevations` 풀스택 양방향 이력 관리 | `undoLastPoint()` 최근 클릭한 1개 포인트 삭제만 지원 (Redo 없음) | **DIFFERENT** |

---

## 4. 동일 GPX 5개 파일 비교 실측 테스트

실제 브라우저 환경(Chromium Headless)에서 두 엔진을 로드하고, 5개의 실측 GPX 파일(트레일 2개, 로드마라톤 3개)을 각각 투입하여 처리 결과를 1:1로 정밀 측정 및 대조하였습니다.

### 4.1 실측 결과 비교표

| 대상 파일 | 파일 유형 | 엔진 구분 | 포인트 수 | trkseg 수 | 총 거리 (km) | 누적상승고도 (D+) | 누적하강고도 (D-) | 고도 범위 (최저~최고) |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **청량산 15K**<br>`cheonglyangsan_15k.gpx` | 트레일 | **GPX Editor** | **11,401개** | **168개** | **14.878 km** | **1,810 m** (순수/1m필터) | **1,782 m** | 193 m ~ 871 m |
| | | **Creator 원본** | 11,401개 | - | 14.878 km | 1,810 m (Hysteresis) | 1,782 m | 193 m ~ 871 m |
| | | **Creator 가공** | 2,977개 (리샘플링) | 1개 (병합손실) | 14.880 km | 1,810 m | 1,782 m | 193 m ~ 871 m |
| **태백산 트레일 50K**<br>`dynafit_taebaek_trail.gpx` | 트레일 | **GPX Editor** | **1,342개** | **1개** | **49.951 km** | **1,882 m** (1m필터: 1,869m) | **1,882 m** | 619.6 m ~ 1,534.7 m |
| | | **Creator 원본** | 1,342개 | - | 49.951 km | 1,881 m (Hysteresis) | 1,881 m | 619.6 m ~ 1,534.7 m |
| | | **Creator 가공** | 9,992개 (리샘플링) | 1개 | 49.950 km | 1,881 m | 1,881 m | 619.6 m ~ 1,534.7 m |
| **춘천 풀코스 42K**<br>`chuncheon_full.gpx` | 로드 | **GPX Editor** | **10,780개** | **1개** | **42.472 km** | **330 m** (1m필터: 208m) | **326 m** | 71.0 m ~ 114.2 m |
| | | **Creator 원본** | 10,780개 | - | 42.472 km | 214 m (Hysteresis) | 210 m | 71.0 m ~ 114.2 m |
| | | **Creator 가공** | 4,249개 (리샘플링) | 1개 | 42.500 km | **182 m** (가우시안 스무딩) | **178 m** | 71.2 m ~ 113.4 m |
| **순천만 울트라 100K**<br>`suncheon_bay_ultra.gpx` | 로드 | **GPX Editor** | **3,902개** | **1개** | **103.197 km** | **2,545 m** (1m필터: 2,372m) | **2,544 m** | 0.0 m ~ 313.2 m |
| | | **Creator 원본** | 3,902개 | - | 103.197 km | 2,204 m (Hysteresis) | 2,203 m | 0.0 m ~ 313.2 m |
| | | **Creator 가공** | 10,321개 (리샘플링) | 1개 | 103.200 km | **1,388 m** (가우시안 스무딩) | **1,388 m** | 0.4 m ~ 309.9 m |
| **YTN 서울마라톤**<br>`YTN_seoulmarathon.gpx` | 로드 | **GPX Editor** | **2,410개** | **1개** | **21.180 km** | **359 m** (1m필터: 328m) | **340 m** | 14.4 m ~ 70.7 m |
| | | **Creator 원본** | 2,410개 | - | 21.180 km | 337 m (Hysteresis) | 318 m | 14.4 m ~ 70.7 m |
| | | **Creator 가공** | 2,119개 (리샘플링) | 1개 | 21.200 km | **274 m** (가우시안 스무딩) | **251 m** | 14.6 m ~ 66.2 m |

---

## 5. 핵심 차이점 분석

```mermaid
graph TD
    subgraph "GPX Editor (독립 내장 엔진)"
        E1["원본 GPX (XML DOM)"] --> E2["계층 구조 보존 파싱<br>(trk, trkseg, wpt)"]
        E2 --> E3["원본 좌표 100% 보존"]
        E3 --> E4["Open-Elevation 96개 표본 조회"]
        E4 --> E5["대표 지점 간 선형 보간 (Linear)"]
        E5 --> E6["단순 임계값 D+ 계산 (0m / 1m)"]
        E6 --> E7["다중 trkseg / wpt 100% 복원 Export"]
    end

    subgraph "GPX Creator (RunruunElevationEngine)"
        C1["원본 GPX / 사용자 생성 좌표"] --> C2["단일 1D 배열 평탄화 (Flatten)"]
        C2 --> C3["등간격 리샘플링 (5m / 10m)"]
        C3 --> C4["Open-Meteo 50개 배치 전수 조회"]
        C4 --> C5["공간 가우시안 스무딩 (15m / 60m)<br>+ 경사도 리미터"]
        C5 --> C6["Hysteresis 데드밴드 D+ 계산 (1m / 3m)"]
        C6 --> C7["단일 trkseg 강제 병합 Export"]
    end
```

### 5.1 거리 계산 (거리 일치율: 100%)
- **일치 확인**: 두 엔진 모두 WGS-84 평균 곡률반경 $R = 6,371,000m$ 기반의 하버사인(Haversine) 공식을 정확히 사용하고 있어, 원본 포인트 기준 거리 계산 결과가 소수점 3자리(미터 단위)까지 **100% 동일**합니다.
  - 청량산: `14.878 km` vs `14.878 km`
  - 태백산: `49.951 km` vs `49.951 km`
  - 춘천: `42.472 km` vs `42.472 km`
  - 순천만: `103.197 km` vs `103.197 km`
  - YTN: `21.180 km` vs `21.180 km`

### 5.2 누적 상승고도(D+) 계산 방식의 근본적 차이
- **GPX Editor**:
  - 인접 두 점 간의 차이(`currEle - lastEle`)를 바탕으로 지정된 임계값(0m 또는 1m)을 넘는 변화를 단순 가산하는 **순수 고도차 누적 방식**을 사용합니다.
- **GPX Creator (`RunruunElevationEngine`)**:
  - 로드마라톤과 트레일러닝의 특성에 맞춰 **공간 가우시안 필터링(Sigma 15m/60m)**과 **방향 전환 Hysteresis Deadband 알고리즘(1m/3m)**을 적용합니다.
  - 이로 인해 로드 코스(춘천, 순천만)에서 GPS 미세 진동 노이즈가 대폭 걸러져 **Editor 대비 D+가 30%~45% 낮게 산출**됩니다 (예: 순천만 100K의 경우 Editor 2,545m vs Creator 1,388m).

### 5.3 다중 세그먼트(`trkseg`) 및 무결성 보존의 차이
- **GPX Editor**:
  - 원본 GPX 파일의 구조를 보존하는 것이 최우선 목적이므로, 청량산의 168개 `<trkseg>`와 웨이포인트(`<wpt>`)를 단 1개의 누락 없이 그대로 유지하여 내보냅니다.
- **GPX Creator**:
  - 새로운 코스를 그리는 생성기 특성상, 파싱 및 내보내기 시 모든 좌표를 1개의 단일 `<trkseg>`로 평탄화하여 내보냅니다 (청량산의 경우 168개 세그먼트가 1개로 합쳐짐).

### 5.4 DEM 조회 서비스 및 보간 방식
- **GPX Editor**: Open-Elevation API (SRTM 30m)를 사용하며, 96개 대표 지점만 샘플링하여 선형 보간하고 보간 추정값임을 사용자에게 명확히 고지합니다.
- **GPX Creator**: Open-Meteo API (Copernicus DEM GLO-30) 및 OpenTopoData를 사용하며, 5m/10m 단위로 리샘플링된 전체 좌표를 50개 단위 배치로 전수 조회합니다.

---

## 6. 최종 결론

1. **공통 엔진 공유 여부**: **아니오 (독립 구현)**
   - RunRuun GPX Editor는 RunRuun GPX Creator의 엔진(`runruun-elevation.js`)을 **참조하지 않으며**, 완전히 독립적인 인라인 JS 엔진을 사용하고 있습니다.
2. **알고리즘 및 결과 동일성**:
   - **거리 계산 (Distance)**: 하버사인 공식 사용으로 **동일(EQUIVALENT)**.
   - **GPX 파싱, 좌표 보존, DEM 조회, 고도 필터링, D+/D- 계산, GPX Export, Undo/Redo**: 목적과 요구사항이 완전히 달라 **상당한 차이(DIFFERENT)**가 존재함.
3. **용도별 분리 타당성**:
   - **GPX Editor**: 원본 GPX의 세그먼트·웨이포인트 100% 무결성 보존, 포인트별 정밀 편집 및 상태(measured vs interpolated) 추적이 필수적이므로 현재의 독립 엔진 구조가 적합함.
   - **GPX Creator**: 지도 위 신규 루트 생성, 도로망 스냅, 로드/트레일 프로필별 가우시안 노이즈 필터링 및 D+ 보정이 중심이므로 `RunruunElevationEngine` 파이프라인이 적합함.
