'use strict';
/** 웹 개별기능[ocr-connect]: 연결 점검 화면 */
FR.ocrConnectView = {
  async load() {
    const info = await FR.api('GET', '/api/ocr/connection');
    FR.$('#oc-mode').textContent = info.mode === 'mock' ? '샘플 모드' : '실제 엔진 설정';
    const dl = FR.$('#oc-info');
    dl.replaceChildren();
    const labels = { endpoint: 'TextSense 요청 주소', statusEndpoint: '상태 조회 주소', engineUrl: '엔진 URL', taskName: '작업명', inputUri: '입력 경로', outputUri: '출력 경로' };
    for (const [k, label] of Object.entries(labels)) dl.append(FR.el('dt', {}, label), FR.el('dd', {}, info[k]));
  },
  init() {
    const btn = FR.$('#oc-test');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      FR.$('#oc-result').textContent = '요청 중...';
      try {
        const r = await FR.api('POST', '/api/ocr/connection-test', {});
        const ok = r.reachable && r.accepted;
        FR.$('#oc-summary').replaceChildren(FR.el('div', { class: `banner ${ok ? 'ok' : 'ng'}` }, FR.icon(ok ? 'check-circle' : 'alert'), ok ? `엔진이 요청을 수신했습니다. 응답 시간 ${r.elapsedMs}ms` : r.error ? r.error.message : `요청에 실패했습니다. HTTP ${r.httpStatus}`));
        FR.$('#oc-result').textContent = JSON.stringify(r, null, 2);
      } catch (e) {
        FR.$('#oc-result').textContent = `오류: ${e.message}`;
      } finally { btn.disabled = false; }
    });
  },
};
