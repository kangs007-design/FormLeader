'use strict';
/** 웹 개별기능[dashboard]: 처리 현황 통계 + 최근 처리 문서 */
FR.dashboardView = (() => {
  let timer = null;
  let filter = 'all';

  function renderRows(jobs) {
    const body = FR.$('#db-body');
    if (!jobs.length) {
      body.replaceChildren(FR.emptyRow(6, FR.state.search ? '검색어와 일치하는 문서가 없습니다.' : filter === 'all' ? '첫 문서를 업로드하고 시작해 보세요.' : '이 상태의 문서가 없습니다.'));
      return;
    }
    body.replaceChildren(...jobs.map((j) => {
      const st = FR.jobStatus(j);
      return FR.el('tr', {},
        FR.el('td', {}, FR.fileCell(j)),
        FR.el('td', {}, FR.docTypeLabel(j)),
        FR.el('td', {}, FR.shortDate(j.createdAt)),
        FR.el('td', {}, j.result && j.result.wordCount !== undefined ? j.result.wordCount.toLocaleString('ko-KR') : '—'),
        FR.el('td', {}, FR.el('span', { class: `pill ${st.cls}`, title: j.error || '' }, st.label)),
        FR.el('td', {}, FR.el('div', { class: 'actions' },
          FR.el('button', { class: 'sm', disabled: j.status !== 'done', 'aria-label': `${j.fileName} 결과 보기`, onclick: () => FR.formJobView.showResult(j.id) }, '결과 보기'))));
    }));
  }

  function renderActivity(jobs) {
    const today = new Date();
    const dateKey = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = new Date(today.getTime() - (6 - i) * 86400000);
      return { date, key: dateKey(date), count: 0 };
    });
    jobs.forEach((job) => { const day = days.find((d) => d.key === dateKey(new Date(job.createdAt))); if (day) day.count++; });
    const max = Math.max(1, ...days.map((d) => d.count));
    FR.$('#activity-total').textContent = days.reduce((sum, day) => sum + day.count, 0).toLocaleString('ko-KR');
    const chart = FR.$('#activity-chart');
    chart.setAttribute('aria-label', days.map((d) => `${d.key}: ${d.count}건`).join(', '));
    chart.replaceChildren(...days.map((d, i) => FR.el('div', { class: `activity-day${i === 6 ? ' recent' : ''}`, title: `${d.key} · ${d.count}건` },
      FR.el('div', { class: 'activity-bar', style: `height:${d.count ? 12 + d.count / max * 48 : 3}px` }),
      FR.el('span', {}, new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric' }).format(d.date)))));
  }

  async function load() {
    clearTimeout(timer);
    let jobs;
    try { jobs = await FR.api('GET', '/api/jobs'); } catch (e) { FR.$('#db-body').replaceChildren(FR.emptyRow(6, `문서를 불러오지 못했습니다: ${e.message}`)); return; }

    const groups = { ok: 0, run: 0, review: 0 };
    jobs.forEach((j) => { groups[FR.jobStatus(j).group] += 1; });
    FR.$('#st-total').textContent = jobs.length;
    FR.$('#st-ok').textContent = groups.ok;
    FR.$('#st-run').textContent = groups.run;
    FR.$('#st-review').textContent = groups.review;
    FR.$('#db-count').textContent = jobs.length;
    FR.$('#nav-job-count').textContent = jobs.length;
    renderActivity(jobs);

    renderRows(jobs.slice().reverse().filter(FR.jobMatchesSearch).filter((j) => filter === 'all' || FR.jobStatus(j).group === filter).slice(0, 6));
    if (groups.run) timer = setTimeout(() => { if (FR.$('#tab-dashboard').classList.contains('active')) load(); }, 2000); // 처리 중이면 자동 갱신
  }

  function init() {
    FR.$('#db-filters').addEventListener('click', (event) => {
      const button = event.target.closest('[data-filter]');
      if (!button) return;
      filter = button.dataset.filter;
      FR.$('#db-filters').querySelectorAll('button').forEach((b) => { b.classList.toggle('active', b === button); b.setAttribute('aria-pressed', String(b === button)); });
      load();
    });
  }
  return { load, init };
})();
