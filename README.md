# DigitalLeader v1.0 (Node.js) — TextSense AI OCR 연동

TextSense AI OCR 과 연계해 이미지/PDF 내 정형 서식을 인식하고 Key-Value 로 변환하는 웹 도구입니다.
외부 패키지 없이 Node.js(18+)만으로 동작합니다. (`npm install` 불필요)

## 바로 실행

```bash
# 1) VPN 없이 화면/연동 확인 (내장 Mock TextSense 사용)
npm run start:mock          # → http://localhost:3000

# 2) 실서버 사용: .env.example 을 .env 로 복사 후 값 수정
npm start                   # → http://localhost:3000

# 연결 테스트 (textsense.py 의 Node.js 버전)
npm run test:connection:mock   # Mock 서버
npm run test:connection        # 실제 서버 (VPN 연결 필요)

# 자동 테스트 (단위 + 모듈 연결)
npm test
```

## 폴더 구조 / Naming rule

- 폴더: `kebab-case`, 파일: `<이름>.<역할>.js` (역할: config, util, error, client, repository, service, controller, validator, extractor, view, script)
- 공통(`common`)과 개별기능(`features/<기능>`)을 분리하고, 개별기능 파일은 기능명으로 시작합니다.

```
formreader/
├─ src/
│  ├─ server.js                      모듈 조립 / HTTP 서버
│  ├─ common/                        ★ 공통 (기능 무관, 재사용)
│  │  ├─ app.config.js               .env + 환경설정
│  │  ├─ app.error.js                표준 에러
│  │  ├─ logger.util.js / id.util.js
│  │  ├─ http-json.client.js         JSON HTTP 클라이언트(타임아웃)
│  │  ├─ http-response.util.js       응답/본문 파싱/정적 파일
│  │  ├─ router.util.js              라우터
│  │  └─ json-file.repository.js     JSON 파일 저장소
│  ├─ features/                      ★ 개별 기능
│  │  ├─ ocr-connect/                TextSense 연결 (textsense.py 대응)
│  │  ├─ form-template/              서식 등록/수정/삭제 + 입력 검증
│  │  ├─ form-job/                   파일 업로드 → OCR 요청 → 결과 수신
│  │  └─ ocr-result/                 OCR JSON 정규화, Key-Value 추출/검증, 자동 분류
│  └─ web/                           화면 (common/api.util.js + features/*.view.js)
├─ tests/  unit/  connection/  mock/ (Mock TextSense)
├─ scripts/                          연결 테스트, Mock 포함 실행
└─ data/                             실행 중 생성되는 서식/작업/입출력 파일
```

## 화면 디자인 / CSS 구조

네이비 사이드바 + 상단 검색바 + 카드 레이아웃. CSS 는 JS/HTML 과 분리해 **공통(common)** 과 **기능별(features)** 로 관리합니다.

```
src/web/
├─ index.html
├─ css/
│  ├─ common/              공통 스타일
│  │  ├─ tokens.css        색상·반경·그림자 등 디자인 토큰 (테마를 바꿀 때는 이 파일만 수정)
│  │  ├─ base.css          리셋 / 타이포그래피 / 스크롤바
│  │  ├─ layout.css        사이드바 · 상단바 · 페이지 헤더 · 반응형
│  │  └─ components.css    카드 · 버튼 · 입력 · 표 · 상태 배지 · 배너
│  └─ features/            기능별 스타일 (JS 의 features/*.view.js 와 1:1)
│     ├─ dashboard.css     통계 카드
│     ├─ job-request.css   업로드(Drag&Drop) · 진행 로그
│     ├─ form-template.css 서식 목록 · Rect 편집기 · Key 표
│     ├─ ocr-result.css    문서 확인(문서 뷰어 + 인식 결과) · 페이지별 상세
│     └─ ocr-connect.css   설정 · 연결 점검
├─ js/  common/api.util.js · features/*.view.js(doc-viewer.view.js = 원본 문서 뷰어) · main.js
└─ vendor/pdfjs/           PDF 렌더링 라이브러리 pdf.js 6.4.299 (Apache-2.0, 내장 — 인터넷/CDN 불필요)
                           build/ 본체·워커, cmaps/ 한글 등 CJK 글꼴, standard_fonts/, wasm/ 스캔 PDF 디코더, iccs/
```

| 메뉴 | 내용 |
|---|---|
| 대시보드 | 처리한 문서 / 정상 인식 / 처리 중 / 검토 필요·실패 통계, 최근 처리 문서 |
| 문서 처리 | 서식 선택 + Drag&Drop 업로드, 진행 상태 표시 (1건 업로드 시 완료되면 결과 자동 이동) |
| 작업 현황 | 전체 작업 목록 · 상태 배지 · 결과 보기/삭제 |
| 서식 관리 | 서식 목록, 문서유형/키워드, Rect 드래그 · Key 검증(필수·검증키·패턴·범위·예외값) |
| 문서 확인 | 좌: **업로드한 원본 문서 그대로**(PDF 는 pdf.js 로 렌더링해 글꼴·표·색·도장을 유지, 이미지는 원본 표시) + 페이지 이동·확대/축소, `인식 영역` 버튼으로 인식 박스 오버레이, `텍스트` 버튼으로 인식 텍스트 재현 보기 전환 / 우: 인식 결과(Key-Value·검증·요약) / 하: **페이지 탭**(1·2·3 페이지…) 안에 본문 텍스트·표·SearchAPI 필드·단어 목록 하위 탭 (뷰어와 페이지 연동) |
| 설정 | TextSense 연결 정보와 연결 테스트 |

상단 검색창은 파일명·문서 유형으로 대시보드/작업 현황을 필터링합니다.

## 화면 기능 요약 (설명서 기준)

| 탭 | 기능 |
|---|---|
| 작업 요청 | Drag&Drop 다중 파일 업로드, 서식 지정 또는 키워드 자동 분류 |
| 작업 현황 | 대기/처리중/완료/실패 목록, 삭제 |
| 서식 설정 | 문서유형, 분류 키워드, 이미지 위 Rect 드래그로 Key 추가, 필수/검증키/패턴/범위(최소·최대)/예외값 |
| OCR 결과 | Key-Value 값, 검증 결과, 미분류 표시, 원본 JSON |
| 연결 점검 | `textsense.py` 와 동일한 build 요청으로 서버 연결 테스트 |

## TextSense 연동 (공식 REST API 2.0.0 기준)

참고: https://technet.epapyrus.com/view/docs/textsense/2.0.0/rest-api/overview-rest-api

| 단계 | API | 구현 위치 |
|---|---|---|
| 1. 작업 요청 | `POST /textsense/api/job/build` → `{ id, name, status }` | `textsense.client.js` `buildJob()` |
| 2. 상태 확인 | `POST /textsense/api/job/status` `{type:"OBJECT_ID", id}` → `SUCCESS/FAILURE/AWAITING/PROGRESSING` | `getStatus()` + `form-job.service.js` 폴링 |
| 3. 오류 조회 | `GET /textsense/api/job/errors?type=OBJECT_ID&id=` (FAILURE 시) | `getErrors()` |
| 4. 결과 읽기 | `outputUri` 로 지정한 `<작업ID>.json` 파일 (outputType=json) | `form-job.service.js` |

- `outputUri` 는 결과 파일 자체의 경로입니다. (`file:///ePapyrus/data/output/<작업ID>.json`)
- 결과 JSON(`document.pages.pages_N` → `elements`(word/textline/cell/table), `content`, `fields`)을 파싱해 **페이지별 본문 텍스트, 표, 단어(신뢰도/좌표), SearchAPI 필드**를 화면에 보여줍니다. (`ocr-result.extractor.js`)

### 파일 전달 방식

공식 REST API 에는 결과 파일을 내려받는 API 가 없습니다. 결과 JSON 은 `outputUri` 에 지정한 저장소로 TextSense 가 직접 씁니다. (실서버에서 확인: 추정 가능한 download/result 경로는 모두 404/405)

1. **VPN 권장 – 공유 폴더 불필요 (입력 HTTP + 결과 FTP)**
   `.env` 에 `FORMREADER_PUBLIC_URL=auto`, `FTP_ENABLED=true`, `FTP_PUBLIC_HOST=auto` 를 설정합니다.
   - 입력: TextSense 가 `http://<이 PC>:3000/files/input/<파일>` 에서 PDF 를 가져갑니다.
   - 결과: TextSense 가 `ftp://<이 PC>:2121/<작업ID>.json` 으로 업로드 → 내장 FTP 수신기(`src/common/ftp-receiver.server.js`)가 `LOCAL_OUTPUT_DIR` 에 저장합니다. (비밀번호는 실행마다 임의 생성, 업로드 전용, 파일명 제한)
   - `auto` 는 TextSense 서버로 나가는 경로의 이 PC 주소를 작업마다 감지합니다. **OpenVPN 은 접속할 때마다 주소가 바뀌므로**(예: 192.168.5.7 → 192.168.5.5) 고정 주소를 쓰면 `Failed to fetch [http://…]`(BPG122000) 오류가 납니다.
   - 필요 조건: TextSense 서버 → 이 PC 의 TCP 3000, 2121, 50000-50020 접속 허용 (Windows 방화벽에서 node.exe 인바운드 허용).
2. **공유 폴더**: `LOCAL_INPUT_DIR` / `LOCAL_OUTPUT_DIR` 이 ePapyrus 서버의 `EPAPYRUS_INPUT_URI` / `EPAPYRUS_OUTPUT_URI` 와 같은 저장소(공유 폴더/마운트)를 가리키게 설정합니다.

실패 시 작업 현황에 TextSense 의 오류 코드/메시지(`/job/errors`)가 그대로 표시됩니다. 결과 파일이 없으면 “결과 파일을 찾을 수 없습니다 (LOCAL_OUTPUT_DIR 확인)” 로 실패합니다.

### 인식 옵션 (REST API 매뉴얼 반영)

문서 처리 화면의 **고급 인식 옵션**과 서식의 **SearchAPI 규칙**으로 TextSense 요청(`extraJobs[].option`)을 조정할 수 있습니다. 지정하지 않으면 기본값(`pages: "all"`, `reqOption: {}`)으로 이전과 똑같이 요청합니다.

| 항목 | 요청 위치 | 비고 |
|---|---|---|
| 인식할 페이지 | `pages` | `all` / `1-3` / `1,3,5`. 정렬·중복 제거 후 전달. **결과의 `pages_N` 은 요청한 페이지 순서의 번호이므로 원본 페이지 번호로 복원해 표시** (뷰어·서식 Key 의 페이지도 원본 기준) |
| 표 구조 무시 | `reqOption.ResultOption.Format = "PlainText"` | |
| 전처리 | `reqOption.PreProcessOption` (`denoising`, `ScaleUp`) | |
| 검출 설정 | `reqOption.CustomSetting` | TextInputMaxAxis, TableInputMaxAxis, TextScoreThreshold, TableCellScoreThreshold, CellAlignSearchMargin, CellAlignGridMargin (화면은 앞의 2개, 나머지는 API) |
| SearchAPI | `reqOption.SearchAPI` | FindRow / FindRightRow / FindCol / FindBottomCol / FindWord / FindLine (Key: 문자열 목록), FindRegion (Key: 좌상단·우하단 좌표). 서식에 등록한 규칙 + 작업에서 직접 지정한 규칙을 합쳐 전달(이름 중복 불가). 결과는 “SearchAPI 필드” 탭 |
| 완료 콜백 | `callbackUri` | `TEXTSENSE_CALLBACK=true` + `FORMREADER_PUBLIC_URL` 설정 시 사용. 콜백은 **폴링을 즉시 깨우는 신호로만** 쓰고(본문은 신뢰하지 않음) 성공/실패는 항상 status API 로 확인 |

API 로 직접 올릴 때는 `POST /api/jobs` 본문에 `options` 를 넣습니다.

```json
{ "fileName": "a.pdf", "contentBase64": "...", "templateId": "form_...",
  "options": { "pages": "2-3", "plainText": false, "denoising": true, "scaleUp": false,
               "customSetting": { "TextInputMaxAxis": 2200 },
               "searchApi": [ { "type": "FindLine", "name": "date", "key": ["일시"] },
                              { "type": "FindRegion", "name": "box", "key": [[10, 20], [110, 60]] } ] } }
```

결과 화면은 표의 병합 셀(`row_span`/`column_span`)을 반영하고, 페이지별 분류·정렬·엔진 버전 정보가 있으면 함께 표시합니다. 오류 조회(`/job/errors`)의 메시지는 한 줄로 정리하고 `ftp://user:password@` 같은 접속 정보는 가려서 표시합니다.

미지원: 결과 형식 `pdf`/`excel`/`text`/`text-split` (화면 표시를 위해 `json` 만 사용), `wordCorrection`(사용자 사전 마운트 필요).

### 알려진 제약

- 결과 JSON 의 좌표(`points`)는 이미지 픽셀 기준이고 **페이지 크기 정보는 포함되지 않습니다.** 서식 영역(0~1 비율)은 이미지 업로드 시 헤더(PNG/JPEG/BMP)에서 읽은 크기로, **PDF 는 인식된 단어의 분포로 페이지 크기를 추정**합니다. 따라서 PDF 에서 서식 Key 영역 추출은 근사치이며, 정확도가 필요하면 SearchAPI(`FindRegion` 등) 연동이 필요합니다. (OCR 본문/표/단어 추출은 영향 없음)
- 서식 설정 화면의 미리보기는 이미지만 지원하며 PDF 는 좌표를 직접 입력합니다.
- 문서 확인의 원본 표시: PDF·PNG·JPG·BMP 지원. TIFF 는 브라우저가 표시하지 못해 자동으로 `텍스트` 보기로 대체됩니다. `인식 영역` 오버레이는 TextSense 가 PDF 를 72dpi 의 2배로 변환한다는 관찰값(`doc-viewer.view.js` 의 `PDF_OCR_SCALE`)을 기준으로 위치를 맞추며, 인식 좌표가 이를 넘으면 자동 보정합니다. 원본 파일은 `GET /api/jobs/<작업ID>/file` 로만 제공됩니다(작업 id 로만 접근, 경로 직접 지정 불가).
- 완료 콜백(`/api/textsense/callback`)은 인증이 없으므로 내부망/VPN 에서만 켜세요. (켜지 않으면 경로 자체가 없습니다)
- 로그인/인증은 포함하지 않았습니다. 내부망 전용으로 사용하세요.
- 자동 테스트(`npm test`)는 공식 문서 기반 Mock 서버로 수행하며 `.env` 를 읽지 않습니다. 실서버 종단 테스트는 `npm start` 후 PDF 를 업로드해 확인합니다. (2025-11-12: 실서버에서 PDF 업로드 → HTTP 입력 → OCR → FTP 결과 수신 → 화면 표시까지 확인)
- `npm run start:mock` 은 고정 샘플 결과를 돌려주는 Mock 이므로 업로드한 파일을 실제로 OCR 하지 않습니다. 실제 OCR 은 `npm start` 를 사용하세요. Mock 으로 만든 작업 기록은 실제 결과가 아니니 삭제해서 쓰세요.
