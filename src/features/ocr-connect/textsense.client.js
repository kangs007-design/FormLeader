'use strict';
/**
 * 개별기능[ocr-connect]: TextSense(textsense-gateway) REST API 클라이언트
 * 참고: https://technet.epapyrus.com/view/docs/textsense/2.0.0/rest-api/overview-rest-api
 *   POST /textsense/api/job/build   작업 요청  → { id, name, status }
 *   POST /textsense/api/job/status  상태 조회  → { status: SUCCESS|FAILURE|AWAITING|PROGRESSING }
 *   GET  /textsense/api/job/errors  오류 조회  → 200 { errors: [...] } / 404 작업 없음 / 400 파라미터 오류 (정상 종료 작업은 빈 객체 또는 400)
 */
const { requestJson } = require('../../common/http-json.client');
const { maskUriCredentials } = require('../../common/mask.util');

/**
 * job build 요청 본문 생성
 * - outputUri 는 결과 파일 자체의 경로 (outputType=json 이면 .json 파일)
 * - reqType 은 고정값 Document, reqOption 기본값은 {}
 */
function buildJobBody({ inputUri, outputUri, taskName, engineUrl, pages = 'all', outputType = 'json', reqType = 'Document', reqOption = {}, callbackUri }) {
  const body = {
    inputUri,
    outputUri,
    option: { withoutConversion: true },
    taskName,
    extraJobs: [
      {
        type: 'textSense',
        option: { url: engineUrl, reqType, reqOption, outputType, pages },
      },
    ],
  };
  if (callbackUri) body.callbackUri = callbackUri;
  return body;
}

/**
 * /job/errors 응답 → [{ id, code, message, timestamp }]  (오류가 없거나 조회할 수 없으면 빈 배열)
 * message 는 한 줄로 줄이고 URI 속 접속 정보(ftp://user:pass@)는 가린다. (cause 는 스택트레이스라 첫 줄만 사용)
 */
const firstLine = (v) => String(v || '').split(/\r?\n/)[0];
const oneLine = (v) => String(v || '').replace(/\s*[\r\n]+\s*/g, ' ').trim();

function parseErrors(res) {
  const list = res && res.status === 200 && res.json && Array.isArray(res.json.errors) ? res.json.errors : [];
  return list.map((e) => ({
    id: e.id || null,
    code: e.code || null,
    message: oneLine(maskUriCredentials(e.message || firstLine(e.cause))).slice(0, 300),
    timestamp: typeof e.timestamp === 'number' ? e.timestamp : null,
  }));
}

class TextSenseClient {
  /** @param config app.config 의 전체 설정 */
  constructor(config) {
    this.config = config;
  }

  _call(opts) {
    const { textsense, requestTimeoutMs } = this.config;
    return requestJson({ host: textsense.host, port: textsense.port, timeoutMs: requestTimeoutMs, ...opts });
  }

  /** 작업 요청. 성공 시 res.json = { id, name, status } */
  buildJob(params) {
    const { textsense } = this.config;
    const body = buildJobBody({ engineUrl: textsense.engineUrl, taskName: textsense.taskName, ...params });
    return this._call({ path: textsense.buildPath, method: 'POST', body }).then((res) => ({ ...res, requestBody: body }));
  }

  /** 작업 상태 조회. 없는 작업이면 HTTP 404 */
  getStatus(id) {
    return this._call({ path: this.config.textsense.statusPath, method: 'POST', body: { type: 'OBJECT_ID', id } });
  }

  /** 작업 오류 내역 조회 (정상 작업은 빈 객체) */
  getErrors(id) {
    const q = `type=OBJECT_ID&id=${encodeURIComponent(id)}`;
    return this._call({ path: `${this.config.textsense.errorsPath}?${q}`, method: 'GET' });
  }
}

module.exports = { TextSenseClient, buildJobBody, parseErrors };
