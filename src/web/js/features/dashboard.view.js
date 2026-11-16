'use strict';
/** 웹 개별기능[dashboard]: 처리 현황 통계 + 최근 처리 문서 */
FR.dashboardView = (() => {
  let timer = null;

  function renderRows(jobs) {
    const body = FR.$('#db-body');
    if (!jobs.length) {
      body.replaceChildren(FR.el('tr', {}, FR.el('td', { class: 'empty', colspan: 6 }, FR.state.search ? '검색 결과가 없습니다.' : '처리한 문서가 없습니다. “문서 업로드”로 시작하세요.')));
      return;
    }
    body.replaceChildren(...jobs.map((j) => {
      const st = FR.jobStatus(j);
      return FR.el('tr', {},
        FR.el('td', {}, FR.el('div', { class: 'file-cell' }, FR.icon('doc'), j.fileName)),
        FR.el('td', {}, FR.docTypeLabel(j)),
        FR.el('td', {}, FR.fmtTime(j.createdAt)),
        FR.el('td', {}, j.result && j.result.wordCount !== undefined ? `${j.result.wordCount}개` : '-'),
        FR.el('td', {}, FR.el('span', { class: `pill ${st.cls}`, title: j.error || '' }, st.label)),
        FR.el('td', {}, FR.el('div', { class: 'actions' },
          FR.el('button', { class: 'sm', disabled: j.status !== 'done', onclick: () => FR.formJobView.showResult(j.id) }, '결과 보기'))));
    }));
  }

  async function load() {
    clearTimeout(timer);
    let jobs;
    try { jobs = await FR.api('GET', '/api/jobs'); } catch (e) { console.error(e); return; }

    const groups = { ok: 0, run: 0, review: 0 };
    jobs.forEach((j) => { groups[FR.jobStatus(j).group] += 1; });
    FR.$('#st-total').textContent = jobs.length;
    FR.$('#st-ok').textContent = groups.ok;
    FR.$('#st-run').textContent = groups.run;
    FR.$('#st-review').textContent = groups.review;

    renderRows(jobs.slice().reverse().filter(FR.jobMatchesSearch).slice(0, 8));
    if (groups.run) timer = setTimeout(() => { if (FR.$('#tab-dashboard').classList.contains('active')) load(); }, 2000); // 처리 중이면 자동 갱신
  }

  return { load };
})();
