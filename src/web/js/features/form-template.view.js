'use strict';
/** 웹 개별기능[form-template]: 서식 설정 화면 (Rect 그리기 / Key-Value 편집) */
FR.formTemplateView = (() => {
  let forms = [];
  let currentId = null;
  let keys = [];
  const imgState = { w: 0, h: 0 };

  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
  const round = (n) => Math.round(n * 10000) / 10000;

  function emptyKey(n) {
    return { name: `key${n}`, page: 1, mode: 'rect', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.05 }, required: false, verify: false, pattern: '', min: null, max: null, exceptValues: [] };
  }

  function renderList() {
    const ul = FR.$('#ft-list');
    ul.replaceChildren(...forms.map((f) => FR.el('li', { class: f.id === currentId ? 'sel' : '', onclick: () => select(f.id) }, `${f.name} (${f.docType})`)));
  }

  function renderRects() {
    const box = FR.$('#ft-rects');
    box.replaceChildren(...keys.filter((k) => k.page === 1).map((k) => FR.el('div', {
      class: 'rect',
      style: `left:${k.rect.x * 100}%;top:${k.rect.y * 100}%;width:${k.rect.w * 100}%;height:${k.rect.h * 100}%`,
    }, k.name)));
  }

  function renderKeys() {
    const body = FR.$('#ft-keys');
    body.replaceChildren(...keys.map((k, i) => {
      const bind = (attrs, get, set) => FR.el('input', { ...attrs, value: get(), onchange: (e) => { set(e.target.value, e.target); renderRects(); } });
      const chk = (field) => FR.el('input', { type: 'checkbox', checked: k[field], onchange: (e) => { k[field] = e.target.checked; } });
      const rectIn = (f) => bind({ type: 'number', step: '0.001', min: '0', max: '1' }, () => k.rect[f], (v) => { k.rect[f] = Number(v); });
      const mode = FR.el('select', { onchange: (e) => { k.mode = e.target.value; } },
        ['rect', 'line', 'cell', 'word'].map((m) => FR.el('option', { value: m, selected: m === k.mode }, m)));
      return FR.el('tr', {},
        FR.el('td', {}, bind({}, () => k.name, (v) => { k.name = v.trim(); })),
        FR.el('td', {}, bind({ type: 'number', min: '1' }, () => k.page, (v) => { k.page = Number(v) || 1; })),
        FR.el('td', {}, mode),
        ...['x', 'y', 'w', 'h'].map((f) => FR.el('td', {}, rectIn(f))),
        FR.el('td', {}, chk('required')), FR.el('td', {}, chk('verify')),
        FR.el('td', {}, bind({ class: 'wide' }, () => k.pattern, (v) => { k.pattern = v; })),
        FR.el('td', {}, bind({ type: 'number' }, () => (k.min ?? ''), (v) => { k.min = num(v); })),
        FR.el('td', {}, bind({ type: 'number' }, () => (k.max ?? ''), (v) => { k.max = num(v); })),
        FR.el('td', {}, bind({ class: 'wide' }, () => k.exceptValues.join(','), (v) => { k.exceptValues = v.split(',').map((s) => s.trim()).filter(Boolean); })),
        FR.el('td', {}, FR.el('button', { class: 'sm danger', onclick: () => { keys.splice(i, 1); renderKeys(); renderRects(); } }, '삭제')));
    }));
  }

  function fillEditor(form) {
    FR.$('#ft-name').value = form ? form.name : '';
    FR.$('#ft-doctype').value = form ? form.docType : '';
    FR.$('#ft-keywords').value = form ? form.keywords.join(', ') : '';
    keys = form ? JSON.parse(JSON.stringify(form.keys)) : [emptyKey(1)];
    FR.$('#ft-msg').textContent = '';
    renderKeys(); renderRects(); renderList();
  }

  function select(id) { currentId = id; fillEditor(forms.find((f) => f.id === id)); }

  async function load() {
    forms = await FR.api('GET', '/api/forms');
    if (currentId && !forms.some((f) => f.id === currentId)) currentId = null;
    renderList();
  }

  function collect() {
    return {
      name: FR.$('#ft-name').value, docType: FR.$('#ft-doctype').value,
      keywords: FR.$('#ft-keywords').value.split(',').map((s) => s.trim()).filter(Boolean),
      keys,
    };
  }

  function initCanvas() {
    const canvas = FR.$('#ft-canvas');
    const img = FR.$('#ft-img');
    let start = null;
    let draft = null;
    const pos = (e) => {
      const r = img.getBoundingClientRect();
      return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
    };
    canvas.addEventListener('mousedown', (e) => {
      e.preventDefault();
      start = pos(e);
      draft = FR.el('div', { class: 'rect draft' });
      FR.$('#ft-rects').append(draft);
    });
    window.addEventListener('mousemove', (e) => {
      if (!start) return;
      const p = pos(e);
      draft.style.left = `${Math.min(start.x, p.x) * 100}%`; draft.style.top = `${Math.min(start.y, p.y) * 100}%`;
      draft.style.width = `${Math.abs(p.x - start.x) * 100}%`; draft.style.height = `${Math.abs(p.y - start.y) * 100}%`;
    });
    window.addEventListener('mouseup', (e) => {
      if (!start) return;
      const p = pos(e);
      const rect = { x: round(Math.min(start.x, p.x)), y: round(Math.min(start.y, p.y)), w: round(Math.abs(p.x - start.x)), h: round(Math.abs(p.y - start.y)) };
      start = null; draft.remove(); draft = null;
      if (rect.w < 0.005 || rect.h < 0.003) return; // 클릭 수준의 드래그는 무시
      const k = emptyKey(keys.length + 1);
      k.rect = rect;
      keys.push(k);
      renderKeys(); renderRects();
    });
    FR.$('#ft-sample').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
      img.src = URL.createObjectURL(file);
      canvas.classList.add('has-img');
    });
  }

  return {
    load,
    init() {
      initCanvas();
      FR.$('#ft-new').addEventListener('click', () => { currentId = null; fillEditor(null); });
      FR.$('#ft-addkey').addEventListener('click', () => { keys.push(emptyKey(keys.length + 1)); renderKeys(); renderRects(); });
      FR.$('#ft-save').addEventListener('click', async () => {
        const msg = FR.$('#ft-msg');
        try {
          const saved = currentId ? await FR.api('PUT', `/api/forms/${currentId}`, collect()) : await FR.api('POST', '/api/forms', collect());
          currentId = saved.id;
          await load();
          FR.setMsg(msg, '저장되었습니다.');
        } catch (e) { FR.setMsg(msg, e.message, false); }
      });
      FR.$('#ft-delete').addEventListener('click', async () => {
        if (!currentId) return;
        try { await FR.api('DELETE', `/api/forms/${currentId}`); currentId = null; fillEditor(null); await load(); }
        catch (e) { FR.setMsg(FR.$('#ft-msg'), e.message, false); }
      });
      fillEditor(null);
    },
    getForms: () => forms,
  };
})();
