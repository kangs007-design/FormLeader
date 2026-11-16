'use strict';
/** 웹 개별기능[form-job]: 문서 업로드(Drag&Drop) / 작업 현황 / 문서 확인(OCR 추출값) 화면 */
FR.formJobView = (() => {
  let timer = null;
  let allText = '';
  const viewer = { view: null, idx: 0, sub: 'text' }; // 문서 뷰어(왼쪽) 상태는 FR.docViewer 가 관리

  const ENGINE_LABEL = { AWAITING: 'TextSense 대기', PROGRESSING: 'OCR 진행중', SUCCESS: 'OCR 완료', FAILURE: 'OCR 실패' };
  const STATUS_LABEL = { pending: '대기', processing: '처리중', done: '완료', failed: '실패' };

  async function loadTemplateOptions() {
    const forms = await FR.api('GET', '/api/forms');
    const sel = FR.$('#jr-template');
    const keep = sel.value;
    sel.replaceChildren(FR.el('option', { value: '' }, '(자동 분류 - 키워드 기반)'),
      ...forms.map((f) => FR.el('option', { value: f.id, selected: f.id === keep }, `${f.name} (${f.docType})`)));
  }

  /** 작업이 끝날 때까지 1초 간격으로 확인하며 진행 상태를 표시. 완료되면 결과 링크를 붙인다. */
  async function watchJob(id, li, fileName, autoShow) {
    const end = Date.now() + 10 * 60 * 1000;
    while (Date.now() < end) {
      let job;
      try { job = await FR.api('GET', `/api/jobs/${id}`); } catch (e) { li.className = 'ng'; li.textContent = `${fileName} → 상태 조회 실패: ${e.message}`; return; }
      if (job.status === 'done') {
        li.className = 'ok';
        li.replaceChildren(`${fileName} → OCR 완료 `, FR.el('a', { onclick: () => showResult(id) }, '[결과 보기]'));
        if (autoShow) showResult(id);
        return;
      }
      if (job.status === 'failed') { li.className = 'ng'; li.textContent = `${fileName} → 실패: ${job.error}`; return; }
      li.textContent = `${fileName} → ${ENGINE_LABEL[job.engineStatus] || STATUS_LABEL[job.status]}...`;
      await new Promise((r) => setTimeout(r, 1000));
    }
    li.className = 'ng'; li.textContent = `${fileName} → 확인 시간 초과. 작업 현황에서 확인하세요.`;
  }

  /** 고급 인식 옵션 (비어 있으면 TextSense 기본값) */
  function collectOptions() {
    const o = {};
    const pages = FR.$('#jr-pages').value.trim();
    if (pages) o.pages = pages;
    if (FR.$('#jr-plain').checked) o.plainText = true;
    if (FR.$('#jr-denoise').checked) o.denoising = true;
    if (FR.$('#jr-scaleup').checked) o.scaleUp = true;
    const custom = {};
    const text = FR.$('#jr-text-axis').value.trim();
    const table = FR.$('#jr-table-axis').value.trim();
    if (text) custom.TextInputMaxAxis = Number(text);
    if (table) custom.TableInputMaxAxis = Number(table);
    if (Object.keys(custom).length) o.customSetting = custom;
    return o;
  }

  async function uploadFiles(files) {
    const log = FR.$('#jr-log');
    const templateId = FR.$('#jr-template').value || undefined;
    const options = collectOptions();
    for (const file of files) {
      const li = FR.el('li', {}, `${file.name} 업로드 중...`);
      log.prepend(li);
      try {
        const job = await FR.api('POST', '/api/jobs', { fileName: file.name, contentBase64: await FR.readFileAsBase64(file), templateId, options });
        watchJob(job.id, li, file.name, files.length === 1); // 한 개만 올리면 완료 시 결과 화면으로 자동 이동
      } catch (e) { li.className = 'ng'; li.textContent = `${file.name} → 실패: ${e.message}`; }
    }
  }

  async function loadStatus() {
    const jobs = await FR.api('GET', '/api/jobs');
    const body = FR.$('#js-body');
    const shown = jobs.slice().reverse().filter(FR.jobMatchesSearch);
    if (!shown.length) {
      body.replaceChildren(FR.el('tr', {}, FR.el('td', { class: 'empty', colspan: 5 }, FR.state.search ? '검색 결과가 없습니다.' : '작업이 없습니다.')));
    } else {
      body.replaceChildren(...shown.map((j) => {
        const st = FR.jobStatus(j);
        return FR.el('tr', {},
          FR.el('td', {}, FR.el('div', { class: 'file-cell' }, FR.icon('doc'), j.fileName)),
          FR.el('td', {}, FR.el('span', { class: `pill ${st.cls}`, title: j.error || '' }, st.label),
            j.status === 'processing' && j.engineStatus ? ` ${ENGINE_LABEL[j.engineStatus] || j.engineStatus}` : '',
            j.error ? FR.el('span', { class: 'hint' }, ` ${j.error}`) : ''),
          FR.el('td', {}, j.templateId ? '지정' : '자동'),
          FR.el('td', {}, FR.fmtTime(j.createdAt)),
          FR.el('td', {}, FR.el('div', { class: 'actions' },
            FR.el('button', { class: 'sm', disabled: j.status !== 'done', onclick: () => showResult(j.id) }, '결과 보기'),
            FR.el('button', { class: 'sm danger', onclick: async () => { await FR.api('DELETE', `/api/jobs/${j.id}`); FR.refreshActive(); } }, '삭제'))));
      }));
    }
    return jobs.some((j) => j.status === 'pending' || j.status === 'processing');
  }

  const confText = (c) => (c === null || c === undefined ? '' : c.toFixed(2));

  /** 병합 셀(rowspan/colspan)을 반영해 표를 그린다. (layout 이 없으면 단순 격자) */
  function renderTable(t) {
    const rows = t.layout || t.grid.map((row) => row.map((text) => ({ text, rowSpan: 1, colSpan: 1 })));
    return FR.el('div', { class: 'words-wrap' }, FR.el('table', { class: 'grid merged' },
      FR.el('tbody', {}, rows.map((row) => FR.el('tr', {}, row.map((c) => FR.el('td', { rowspan: c.rowSpan, colspan: c.colSpan }, c.text)))))));
  }

  /** 페이지 부가 정보 (분류/정렬/설명/엔진 버전) - 값이 있는 것만 태그로 표시 */
  function metaTags(p) {
    const m = p.meta || {};
    const tags = [];
    if (m.classification) tags.push(`분류 ${m.classification.class ?? '-'}${m.classification.confidence !== null ? ` (${Number(m.classification.confidence).toFixed(2)})` : ''}`);
    if (m.alignment) tags.push(`정렬 신뢰도 ${m.alignment.confidence !== null ? Number(m.alignment.confidence).toFixed(2) : '-'}${m.alignment.reference ? ` · 기준 ${m.alignment.reference}` : ''}`);
    if (m.description) tags.push(m.description);
    if (m.version) tags.push(`엔진 ${m.version}`);
    return tags.map((t) => FR.el('span', { class: 'tag' }, t));
  }

  function renderWords(words) {
    return FR.el('div', { class: 'words-wrap' }, FR.el('table', { class: 'grid' },
      FR.el('thead', {}, FR.el('tr', {}, ['#', '텍스트', '신뢰도', '위치 (x1,y1 - x2,y2)'].map((h) => FR.el('th', {}, h)))),
      FR.el('tbody', {}, words.map((w, i) => FR.el('tr', {},
        FR.el('td', {}, i + 1), FR.el('td', {}, w.text),
        FR.el('td', { class: w.conf !== null && w.conf < 0.6 ? 'conf-low' : '' }, confText(w.conf)),
        FR.el('td', {}, `${w.x1},${w.y1} - ${w.x2},${w.y2}`))))));
  }

  /* ---------- 페이지별 추출 결과: 페이지 탭 → (본문 텍스트 / 표 / SearchAPI 필드 / 단어) 하위 탭 ---------- */
  const SUB_TABS = [
    { key: 'text', label: '본문 텍스트', count: () => null },
    { key: 'tables', label: '표', count: (p) => p.tables.length },
    { key: 'fields', label: 'SearchAPI 필드', count: (p) => p.fields.length },
    { key: 'words', label: '단어 목록', count: (p) => p.words.length },
  ];

  /** 탭 버튼 묶음 생성 (role=tablist 접근성 + 좌우 방향키 이동) */
  function buildTabbar(el, items, activeKey, onSelect) {
    el.replaceChildren(...items.map((it) => FR.el('button', {
      class: 'tabbar-btn', role: 'tab', type: 'button', 'aria-selected': String(it.key === activeKey), 'data-key': it.key,
      onclick: () => onSelect(it.key),
    }, it.label, it.count !== null && it.count !== undefined ? FR.el('span', { class: 'count' }, it.count) : '')));
    el.onkeydown = (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const i = items.findIndex((it) => it.key === activeKey);
      const next = items[(i + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length];
      onSelect(next.key);
      const btn = el.querySelector(`[data-key="${next.key}"]`);
      if (btn) btn.focus();
    };
  }

  function renderPageTabs() {
    const pages = viewer.view.pages;
    buildTabbar(FR.$('#or-page-tabs'), pages.map((p, i) => ({ key: String(i), label: `${p.page} 페이지`, count: p.words.length })),
      String(viewer.idx), (k) => selectPage(Number(k)));
  }

  /** 선택한 페이지의 하위 탭 + 내용 */
  function renderPagePanel() {
    const p = viewer.view.pages[viewer.idx];
    const panel = FR.$('#or-page-panel');
    const meta = FR.el('p', { class: 'page-meta' },
      `단어 ${p.words.length}개 · 표 ${p.tables.length}개${p.orientation ? ` · 회전 ${p.orientation * 90}°` : ''} · 좌표 기준 ${p.width}×${p.height}px (${p.sizeSource === 'image' ? '이미지 크기' : '추정'}) `, ...metaTags(p));
    const sub = FR.el('div', { class: 'tabbar sub', role: 'tablist', 'aria-label': '추출 결과 종류' });
    buildTabbar(sub, SUB_TABS.map((t) => ({ key: t.key, label: t.label, count: t.count(p) })), viewer.sub, (k) => { viewer.sub = k; renderPagePanel(); });

    const body = FR.el('div', { role: 'tabpanel' });
    if (viewer.sub === 'text') {
      body.append(FR.el('pre', { class: 'text' }, p.content || '(인식된 텍스트가 없습니다)'));
    } else if (viewer.sub === 'tables') {
      if (!p.tables.length) body.append(FR.el('p', { class: 'panel-empty' }, '이 페이지에서 인식된 표가 없습니다.'));
      p.tables.forEach((t, i) => body.append(FR.el('div', { class: 'table-title' }, `표 ${i + 1} (${t.rows}행 × ${t.cols}열)`), renderTable(t)));
    } else if (viewer.sub === 'fields') {
      if (!p.fields.length) body.append(FR.el('p', { class: 'panel-empty' }, 'SearchAPI 추출 필드가 없습니다. (요청 시 reqOption 에 SearchAPI 를 지정하면 표시됩니다)'));
      else body.append(FR.el('div', { class: 'table-scroll' }, FR.el('table', { class: 'grid' }, FR.el('tbody', {}, p.fields.map((f) => FR.el('tr', {}, FR.el('td', {}, f.name), FR.el('td', {}, f.text)))))));
    } else {
      body.append(p.words.length ? renderWords(p.words) : FR.el('p', { class: 'panel-empty' }, '인식된 단어가 없습니다.'));
    }
    panel.replaceChildren(meta, sub, body);
  }

  /** 페이지 선택: 하단 탭, 상단 문서 뷰어, 상세 내용을 모두 같은 페이지로 맞춘다 */
  function selectPage(i) {
    if (!viewer.view || i < 0 || i >= viewer.view.pages.length) return;
    viewer.idx = i;
    FR.docViewer.show(viewer.idx);
    renderPageTabs();
    renderPagePanel();
  }

  /* ---------- 인식 결과 (우측) ---------- */
  function renderFields(job, view) {
    const r = job.ocrResult;
    const banner = FR.$('#or-banner');
    const pill = FR.$('#or-doctype');
    const box = FR.$('#or-fields');
    box.replaceChildren();

    if (r.classified) {
      banner.className = `banner ${r.needsReview ? 'warn' : 'ok'}`;
      banner.replaceChildren(FR.icon(r.needsReview ? 'alert' : 'check-circle'), r.needsReview ? '검토가 필요한 항목이 있습니다.' : '문서가 성공적으로 인식되었습니다.');
      pill.textContent = r.docType;
      Object.entries(r.values).forEach(([name, v]) => {
        const value = FR.el('div', { class: `field-value${v.value ? '' : ' empty'}${v.valid ? '' : ' invalid'}` },
          FR.el('span', {}, v.value || '(인식된 값 없음)'),
          FR.el('span', { class: `state ${v.valid ? 'ok' : 'ng'}`, title: v.valid ? '검증 통과' : v.errors.join(', ') }, FR.icon(v.valid ? 'check-circle' : 'alert')));
        box.append(FR.el('div', { class: 'field' }, FR.el('span', { class: 'field-label' }, name), value, v.valid ? '' : FR.el('span', { class: 'field-err' }, v.errors.join(', '))));
      });
    } else {
      banner.className = 'banner info';
      banner.replaceChildren(FR.icon('check-circle'), 'OCR 인식이 완료되었습니다. 일치하는 서식이 없어 원문만 제공합니다.');
      pill.textContent = '미분류';
    }

    const words = view.pages.flatMap((p) => p.words).filter((w) => w.conf !== null);
    const avg = words.length ? (words.reduce((a, w) => a + w.conf, 0) / words.length).toFixed(2) : '-';
    const dl = FR.el('dl', { class: 'summary-list' });
    [['페이지', `${r.pageCount}장`], ['인식한 단어', `${r.wordCount}개`], ['표', `${r.tableCount}개`], ['평균 신뢰도', avg], ['처리 시각', FR.fmtTime(job.updatedAt)]]
      .forEach(([k, v]) => dl.append(FR.el('dt', {}, k), FR.el('dd', {}, v)));
    box.append(FR.el('div', { class: 'field' }, FR.el('span', { class: 'field-label' }, '인식 요약'), dl));
  }

  async function showResult(id) {
    FR.$('#or-copy-msg').textContent = '';
    try {
      const [job, view] = await Promise.all([FR.api('GET', `/api/jobs/${id}`), FR.api('GET', `/api/jobs/${id}/ocr`)]);
      FR.$('#or-empty').hidden = true;
      FR.$('#or-detail').hidden = false;
      FR.$('#or-title').textContent = job.fileName;
      const range = job.options && job.options.pages && job.options.pages !== 'all' ? ` · 인식 범위 ${job.options.pages}페이지` : '';
      FR.$('#or-meta').textContent = `${job.ocrResult.pageCount}페이지 · ${job.ocrResult.wordCount}단어${range} · ${FR.fmtTime(job.updatedAt)}`;
      FR.showTab('ocr-result'); // 화면을 먼저 보이게 해야 뷰어가 실제 폭을 측정해서 문서를 그린다

      Object.assign(viewer, { view, idx: 0, sub: 'text' });
      FR.docViewer.open({ jobId: id, fileName: job.fileName, view }); // 원본 문서 뷰어 준비
      renderFields(job, view);
      selectPage(0); // 문서 뷰어 + 페이지 탭 + 상세 내용

      allText = view.pages.map((p) => (view.pages.length > 1 ? `[${p.page} 페이지]\n` : '') + p.content).join('\n\n');
      FR.$('#or-json').textContent = JSON.stringify(job.ocrResult, null, 2);
    } catch (e) {
      FR.$('#or-detail').hidden = true;
      FR.$('#or-empty').hidden = false;
      FR.$('#or-empty').replaceChildren(FR.el('p', { class: 'msg ng' }, `결과를 불러올 수 없습니다: ${e.message}`));
    }
    FR.showTab('ocr-result');
  }

  /** 처리 중인 작업이 있으면 2초마다 현황 갱신 */
  function schedulePoll(active) {
    clearTimeout(timer);
    if (active) timer = setTimeout(() => { if (FR.$('#tab-job-status').classList.contains('active')) refresh(); }, 2000);
  }
  async function refresh() {
    try { schedulePoll(await loadStatus()); } catch (e) { console.error(e); }
  }

  return {
    refresh, loadTemplateOptions, showResult,
    init() {
      const drop = FR.$('#jr-drop');
      const input = FR.$('#jr-file');
      drop.addEventListener('click', () => input.click());
      drop.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.click(); });
      input.addEventListener('change', () => { uploadFiles([...input.files]); input.value = ''; });
      ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
      drop.addEventListener('drop', (e) => uploadFiles([...e.dataTransfer.files]));
      FR.$('#js-refresh').addEventListener('click', refresh);

      FR.$('#or-prev').addEventListener('click', () => selectPage(viewer.idx - 1));
      FR.$('#or-next').addEventListener('click', () => selectPage(viewer.idx + 1));
      FR.docViewer.init();
      FR.$('#or-back').addEventListener('click', () => FR.showTab('job-status'));
      FR.$('#or-goto-form').addEventListener('click', () => FR.showTab('form-template'));

      FR.$('#or-copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(allText); FR.setMsg(FR.$('#or-copy-msg'), '복사되었습니다.'); }
        catch (_) { FR.setMsg(FR.$('#or-copy-msg'), '복사 실패 - 본문 텍스트를 직접 선택해 복사하세요.', false); }
      });
    },
  };
})();
