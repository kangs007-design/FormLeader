'use strict';
/** 웹 진입점: 사이드바 탭 전환 + 검색 + 각 화면 초기화 */
const TAB_LOADERS = {
  dashboard: () => FR.dashboardView.load(),
  'job-request': () => FR.formJobView.loadTemplateOptions(),
  'job-status': () => FR.formJobView.refresh(),
  'form-template': () => FR.formTemplateView.load(),
  'ocr-connect': () => FR.ocrConnectView.load(),
};

FR.showTab = function showTab(name) {
  document.querySelectorAll('#tabs .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  window.scrollTo({ top: 0 });
  if (TAB_LOADERS[name]) Promise.resolve(TAB_LOADERS[name]()).catch((e) => console.error(e));
};

/** 현재 보이는 화면의 목록을 다시 불러온다 (삭제/검색 후) */
FR.refreshActive = function refreshActive() {
  const active = document.querySelector('.tab.active');
  const name = active && active.id.replace(/^tab-/, '');
  if (name === 'dashboard' || name === 'job-status') TAB_LOADERS[name]();
};

document.addEventListener('DOMContentLoaded', () => {
  FR.ocrConnectView.init();
  FR.formTemplateView.init();
  FR.formJobView.init();

  document.querySelectorAll('#tabs .nav-item').forEach((b) => b.addEventListener('click', () => FR.showTab(b.dataset.tab)));
  document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => FR.showTab(b.dataset.goto)));

  let searchTimer = null;
  FR.$('#global-search').addEventListener('input', (e) => {
    FR.state.search = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(FR.refreshActive, 200);
  });

  FR.showTab('dashboard');
});
