'use strict';
/** 웹 공통: API 호출 / DOM 헬퍼 (전역 네임스페이스 FR) */
window.FR = window.FR || {};

FR.$ = (sel, root = document) => root.querySelector(sel);

/** 서버 API 호출. 실패(ok:false) 시 Error 로 throw */
FR.api = async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'X-Requested-With': 'TextSense', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json;
  if (res.status === 401) { location.replace('/login'); throw new Error('로그인이 만료되었습니다.'); }
  try { json = await res.json(); } catch (_) { throw new Error(`서버 응답 오류 (HTTP ${res.status})`); }
  if (!json.ok) throw Object.assign(new Error(json.error && json.error.message ? json.error.message : '요청 실패'), { code: json.error && json.error.code });
  return json.data;
};

/** 요소 생성 (텍스트는 textContent 로 넣어 XSS 방지) */
FR.el = function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) node.append(c instanceof Node ? c : document.createTextNode(String(c ?? '')));
  return node;
};

FR.fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR') : '');

FR.readFileAsBase64 = (file) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
  fr.onerror = () => reject(new Error('파일을 읽을 수 없습니다.'));
  fr.readAsDataURL(file);
});

FR.setMsg = (node, text, ok = true) => {
  // 작업이 성공하면 같은 화면에 남은 입력 오류 표시는 더 이상 유효하지 않다
  if (ok && text) FR.clearFieldErrors(FR.noticeScope(node));
  node.textContent = text;
  node.className = `msg ${ok ? 'ok' : 'ng'}`;
};

/** index.html 의 SVG 스프라이트(#i-이름) 아이콘 */
FR.icon = function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'icon');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
};

/** 전체 문서 검색어 (파일명/문서 유형/본문) */
FR.state = { search: '', contentIds: new Set() };

/* ---------- 공통 유틸 (여러 화면에서 재사용) ---------- */
FR.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** 마지막 호출 후 wait ms 가 지나면 한 번만 실행 */
FR.debounce = function debounce(fn, wait) {
  let timer = null;
  const wrapped = (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
};
FR.fmtNumber = (n) => Number(n || 0).toLocaleString('ko-KR');
/** 탭 섹션(#tab-이름)이 현재 보이는 중인지 */
FR.isTabActive = (name) => { const tab = document.getElementById(`tab-${name}`); return !!tab && tab.classList.contains('active'); };
/** interval 뒤에 해당 탭이 아직 보이는 중이면 fn 을 한 번 실행 (처리 중 목록 자동 갱신용). 반환값은 타이머 id */
FR.pollTab = (tabName, interval, fn) => setTimeout(() => { if (FR.isTabActive(tabName)) fn(); }, interval);
/** 조건(check)이 값을 돌려줄 때까지 interval 마다 확인. 제한 횟수 초과 시 undefined */
FR.waitFor = async function waitFor(check, { interval = 1000, tries = 120 } = {}) {
  for (let i = 0; i < tries; i++) {
    const result = await check(i);
    if (result !== undefined) return result;
    await FR.sleep(interval);
  }
  return undefined;
};
FR.syncJobCount = async () => { const jobs = await FR.api('GET', '/api/jobs'); FR.$('#nav-job-count').textContent = jobs.length; };

FR.fileCell = function fileCell(job) {
  const ext = (job.fileName.split('.').pop() || '').toUpperCase();
  return FR.el('div', { class: 'file-cell' },
    FR.el('span', { class: `file-type${ext !== 'PDF' ? ' image' : ''}`, 'aria-hidden': 'true' }, ext.slice(0, 4)),
    FR.el('div', { class: 'file-info' }, FR.el('span', { class: 'file-title', title: job.fileName }, job.fileName),
      FR.el('span', { class: 'file-meta' }, job.result && job.result.pageCount ? `${job.result.pageCount} 페이지 · ${ext} 문서` : `${ext} 문서`)));
};
FR.shortDate = (iso) => iso ? new Date(iso).toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '—';
FR.emptyRow = (columns, message) => FR.el('tr', {}, FR.el('td', { class: 'empty', colspan: columns },
  FR.el('div', { class: 'empty-table-content' }, FR.icon('folder'), message)));
FR.download = function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = FR.el('a', { href: url, download: name });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/**
 * 브라우저가 검색창을 로그인 아이디 칸으로 보고 계정을 채우는 것을 막는다.
 * 읽기 전용 칸은 자동완성하지 않으므로, 사용자가 선택했을 때만 입력할 수 있게 연다.
 */
FR.blockAutofill = function blockAutofill(input) {
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('name', `q-${input.id}`);
  input.setAttribute('data-lpignore', 'true');
  input.setAttribute('data-1p-ignore', '');
  input.readOnly = true;
  const unlock = () => { input.readOnly = false; };
  input.addEventListener('pointerdown', unlock);
  input.addEventListener('focus', unlock);
  input.addEventListener('blur', () => { input.readOnly = true; });
};

/** 검색어를 한 번만 소문자·공백제거해 두고(필터 호출마다 재계산하지 않도록) 목록 필터 함수를 만든다 */
FR.makeJobSearchFilter = function makeJobSearchFilter() {
  const q = FR.state.search.trim().toLowerCase();
  if (!q) return () => true;
  const contentIds = FR.state.contentIds;
  return (job) => contentIds.has(job.id)
    || (job.fileName || '').toLowerCase().includes(q)
    || (job.owner ? `${job.owner.name} ${job.owner.email}`.toLowerCase().includes(q) : false)
    || (job.result && job.result.docType ? job.result.docType.toLowerCase().includes(q) : false)
    || String(job.id).toLowerCase().includes(q);
};

/** 작업 → 화면 상태 표시 (알약 배지 색/문구). 서식이 적용됐고 검증 실패가 있으면 '검토 필요' */
FR.jobStatus = function jobStatus(job) {
  if (job.status === 'cancelled') return {cls:'review',label:'취소',group:'cancelled'};
  if (job.status === 'failed') return { cls: 'failed', label: '실패', group: 'review' };
  if (job.status !== 'done') return { cls: 'processing', label: '처리중', group: 'run' };
  if (job.review && job.review.confirmed) return { cls: 'done', label: '검수 완료', group: 'ok' };
  if (job.review && job.review.values && Object.values(job.review.values).some((field) => !field.valid)) return { cls: 'review', label: '검토 필요', group: 'review' };
  if (job.result && job.result.needsReview) return { cls: 'review', label: job.result.classified ? '검토 필요' : '미분류', group: 'review' };
  return { cls: 'done', label: '완료', group: 'ok' };
};

FR.docTypeLabel = (job) => (job.status === 'done' ? (job.result && job.result.classified ? job.result.docType : '미분류') : '-');
