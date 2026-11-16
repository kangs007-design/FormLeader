'use strict';
/** 웹 개별기능[ocr-connect]: 연결 점검 화면 */
FR.ocrConnectView = {
  async load() {
    const info = await FR.api('GET', '/api/ocr/connection');
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
        FR.$('#oc-result').textContent = (r.reachable ? '✔ 연결 성공\n' : '✘ 연결 실패\n') + JSON.stringify(r, null, 2);
      } catch (e) {
        FR.$('#oc-result').textContent = `오류: ${e.message}`;
      } finally { btn.disabled = false; }
    });
  },
};
