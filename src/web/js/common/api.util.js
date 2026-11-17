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
  if (!json.ok) throw new Error(json.error && json.error.message ? json.error.message : '요청 실패');
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

FR.setMsg = (node, text, ok = true) => { node.textContent = text; node.className = `msg ${ok ? 'ok' : 'ng'}`; };

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

/** 상단 검색어 (파일명/문서 유형 필터) */
FR.state = { search: '', contentIds: new Set() };
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

FR.jobMatchesSearch = function jobMatchesSearch(job) {
  const q = FR.state.search.trim().toLowerCase();
  if (!q) return true;
  const hay = [job.fileName, job.result && job.result.docType, job.id].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q) || FR.state.contentIds.has(job.id); // 파일명·문서 유형 또는 본문 일치
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
