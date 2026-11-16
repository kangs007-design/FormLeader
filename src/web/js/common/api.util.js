'use strict';
/** 웹 공통: API 호출 / DOM 헬퍼 (전역 네임스페이스 FR) */
window.FR = window.FR || {};

FR.$ = (sel, root = document) => root.querySelector(sel);

/** 서버 API 호출. 실패(ok:false) 시 Error 로 throw */
FR.api = async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json;
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
FR.state = { search: '' };

FR.jobMatchesSearch = function jobMatchesSearch(job) {
  const q = FR.state.search.trim().toLowerCase();
  if (!q) return true;
  const hay = [job.fileName, job.result && job.result.docType, job.id].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
};

/** 작업 → 화면 상태 표시 (알약 배지 색/문구). 서식이 적용됐고 검증 실패가 있으면 '검토 필요' */
FR.jobStatus = function jobStatus(job) {
  if (job.status === 'failed') return { cls: 'failed', label: '실패', group: 'review' };
  if (job.status !== 'done') return { cls: 'processing', label: '처리중', group: 'run' };
  if (job.result && job.result.classified && job.result.needsReview) return { cls: 'review', label: '검토 필요', group: 'review' };
  return { cls: 'done', label: '완료', group: 'ok' };
};

FR.docTypeLabel = (job) => (job.status === 'done' ? (job.result && job.result.classified ? job.result.docType : '미분류') : '-');
