"use strict";
FR.formTemplateView = (() => {
  let forms = [],
    currentId = null,
    keys = [],
    groups = [],
    sample = null,
    retainedSampleId = '',
    page = 1,
    pdf = null,
    selected = 0,
    selectedGroup = 0,
    previewToken = 0,
    renderToken = 0;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const emptyKey = (n) => ({
    name: `key${n}`,
    page,
    mode: "rect",
    rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.05 },
    required: false,
    verify: false,
    pattern: "",
    pattern2: "",
    exceptPattern: "",
    exceptValues: [],
    min: null,
    max: null,
  });
  const number = (v) => (v === "" ? null : Number(v));
  const input = (label, value, set, attrs = {}) =>
    FR.el(
      "label",
      {},
      label,
      FR.el("input", {
        ...attrs,
        value: value ?? "",
        oninput: (e) => {
          set(e.target.value);
          renderRects();
        },
      }),
    );
  const check = (label, value, set) =>
    FR.el(
      "label",
      { class: "rule-check" },
      FR.el("input", {
        type: "checkbox",
        checked: !!value,
        onchange: (e) => set(e.target.checked),
      }),
      label,
    );
  const selectBox = (label, value, options, set) =>
    FR.el(
      "label",
      {},
      label,
      FR.el(
        "select",
        { onchange: (e) => set(e.target.value) },
        options.map(([v, t]) =>
          FR.el("option", { value: v, selected: v === value }, t),
        ),
      ),
    );
  function renderList() {
    FR.$("#ft-list").replaceChildren(
      ...forms.map((f) =>
        FR.el(
          "li",
          { class: f.id === currentId ? "sel" : "" },
          FR.el(
            "button",
            { type: "button", onclick: () => select(f.id) },
            `${f.name} (${f.docType}) · v${f.version || 1}`,
          ),
        ),
      ),
    );
  }
  function renderRects() {
    FR.$("#ft-rects").replaceChildren(
      ...[
        ...keys.map((k, i) => ({
          ...k,
          label: k.name,
          active: i === selected,
        })),
        ...groups.map((g, i) => ({
          ...g,
          label: `반복: ${g.name}`,
          active: i === selectedGroup,
        })),
      ]
        .filter((k) => k.page === page)
        .map((k) =>
          FR.el(
            "div",
            {
              class: `rect${k.active ? " selected" : ""}`,
              style: `left:${k.rect.x * 100}%;top:${k.rect.y * 100}%;width:${k.rect.w * 100}%;height:${k.rect.h * 100}%`,
            },
            k.label,
          ),
        ),
    );
  }
  function rectFields(item) {
    return FR.el(
      "div",
      { class: "coordinate-grid" },
      ...["x", "y", "w", "h"].map((f) =>
        input(f, item.rect[f], (v) => (item.rect[f] = Number(v)), {
          type: "number",
          step: ".001",
          min: "0",
          max: "1",
          "aria-label": `${item.name} ${f}`,
        }),
      ),
    );
  }
  function rules(k) {
    return FR.el(
      "div",
      { class: "validation-grid" },
      input("정규식 1", k.pattern, (v) => (k.pattern = v)),
      input("정규식 2", k.pattern2, (v) => (k.pattern2 = v)),
      input("예외 정규식", k.exceptPattern, (v) => (k.exceptPattern = v)),
      input(
        "예외값 (쉼표)",
        (k.exceptValues || []).join(","),
        (v) =>
          (k.exceptValues = v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)),
      ),
      input("숫자 최솟값", k.min, (v) => (k.min = number(v)), {
        type: "number",
      }),
      input("숫자 최댓값", k.max, (v) => (k.max = number(v)), {
        type: "number",
      }),
      check("필수", k.required, (v) => (k.required = v)),
      check("검증 실패 시 검토", k.verify, (v) => (k.verify = v)),
    );
  }
  function renderKeys() {
    FR.$("#ft-keys").replaceChildren(
      ...keys.map((k, i) =>
        FR.el(
          "div",
          { class: `field-definition${i === selected ? " active-field" : ""}` },
          FR.el(
            "div",
            { class: "field-definition-head" },
            FR.el(
              "button",
              {
                type: "button",
                class: "sm",
                onclick: () => {
                  selected = i;
                  page = k.page;
                  renderKeys();
                  renderSample();
                },
              },
              `영역 ${i + 1}`,
            ),
            input("항목 이름", k.name, (v) => (k.name = v), {
              "aria-label": `항목 ${i + 1} 이름`,
            }),
            input("페이지", k.page, (v) => (k.page = Number(v)), {
              type: "number",
              min: "1",
            }),
            FR.el(
              "button",
              {
                class: "sm danger",
                onclick: () => {
                  keys.splice(i, 1);
                  selected = Math.max(0, selected - 1);
                  renderKeys();
                  renderRects();
                },
              },
              "삭제",
            ),
          ),
          selectBox(
            "추출 방식",
            k.mode,
            [
              ["rect", "Rect (영역)"],
              ["line", "Text Line"],
              ["cell", "Cell"],
              ["word", "Word"],
            ],
            (v) => {
              k.mode = v;
              renderKeys();
            },
          ),
          FR.el(
            "details",
            {},
            FR.el("summary", {}, "좌표·선택 위치·검증·SearchAPI"),
            rectFields(k),
            FR.el(
              "div",
              { class: "validation-grid" },
              ...["lineIndex", "wordIndex", "tableIndex", "row", "column"].map(
                (f) =>
                  input(
                    `${f} (0부터)`,
                    k[f],
                    (v) => {
                      if (v === "") delete k[f];
                      else k[f] = Number(v);
                    },
                    { type: "number", min: "0" },
                  ),
              ),
            ),
            rules(k),
            selectBox(
              "엔진 SearchAPI",
              k.searchType || "",
              [
                ["", "로컬 추출"],
                ["FindRegion", "FindRegion"],
                ["FindLine", "FindLine"],
                ["FindWord", "FindWord"],
                ["FindRow", "FindRow"],
                ["FindRightRow", "FindRightRow"],
                ["FindCol", "FindCol"],
                ["FindBottomCol", "FindBottomCol"],
              ],
              (v) => (k.searchType = v),
            ),
            input(
              "탐색 기준 단어 (FindRegion 제외)",
              k.searchKey,
              (v) => (k.searchKey = v),
            ),
          ),
        ),
      ),
    );
  }
  function renderGroups() {
    FR.$("#ft-groups").replaceChildren(
      ...groups.map((g, i) =>
        FR.el(
          "div",
          { class: "field-definition" },
          FR.el(
            "div",
            { class: "row" },
            FR.el(
              "button",
              {
                class: "sm",
                onclick: () => {
                  selectedGroup = i;
                  page = g.page;
                  FR.$("#ft-draw-target").value = "group";
                  renderSample();
                },
              },
              `반복 영역 ${i + 1}`,
            ),
            input("그룹 이름", g.name, (v) => (g.name = v)),
            FR.el(
              "button",
              {
                class: "sm danger",
                onclick: () => {
                  groups.splice(i, 1);
                  renderGroups();
                  renderRects();
                },
              },
              "그룹 삭제",
            ),
          ),
          FR.el(
            "div",
            { class: "validation-grid" },
            selectBox(
              "행 추출 방식",
              g.source,
              [
                ["table", "표의 행"],
                ["lines", "텍스트 줄"],
              ],
              (v) => (g.source = v),
            ),
            input("시작 페이지", g.page, (v) => (g.page = Number(v)), {
              type: "number",
              min: "1",
            }),
            input(
              "표 번호 (0부터)",
              g.tableIndex,
              (v) => (g.tableIndex = Number(v)),
              { type: "number", min: "0" },
            ),
            input(
              "제외할 앞 행 수",
              g.skipRows,
              (v) => (g.skipRows = Number(v)),
              { type: "number", min: "0" },
            ),
            input(
              "행 높이 비율 (0=자동)",
              g.rowHeight,
              (v) => (g.rowHeight = Number(v)),
              { type: "number", min: "0", max: "1", step: ".001" },
            ),
            check(
              "이후 모든 페이지에 반복",
              g.allPages,
              (v) => (g.allPages = v),
            ),
          ),
          rectFields(g),
          ...g.columns.map((c, j) =>
            FR.el(
              "details",
              { open: true },
              FR.el("summary", {}, `Sub 키 ${j + 1}`),
              FR.el(
                "div",
                { class: "row" },
                input("이름", c.name, (v) => (c.name = v)),
                input(
                  "열 번호 (0부터)",
                  c.column ?? j,
                  (v) => (c.column = Number(v)),
                  { type: "number", min: "0" },
                ),
                FR.el(
                  "button",
                  {
                    class: "sm danger",
                    onclick: () => {
                      g.columns.splice(j, 1);
                      renderGroups();
                    },
                  },
                  "Sub 키 삭제",
                ),
              ),
              rectFields(c),
              rules(c),
            ),
          ),
          FR.el(
            "button",
            {
              class: "sm",
              onclick: () => {
                const c = emptyKey(g.columns.length + 1);
                c.rect = { x: 0, y: 0, w: 1, h: 1 };
                c.column = g.columns.length;
                g.columns.push(c);
                renderGroups();
              },
            },
            "+ Sub 키 추가",
          ),
        ),
      ),
    );
  }
  async function renderSample() {
    const token = ++renderToken;
    FR.$("#ft-page-label").textContent = sample
      ? `${page} / ${sample.pageSizes?.length || 1} 페이지`
      : "샘플 없음";
    FR.$("#ft-prev").disabled = !sample || page <= 1;
    FR.$("#ft-next").disabled =
      !sample || page >= (sample.pageSizes?.length || 1);
    if (!sample) {
      FR.$("#ft-canvas").classList.remove("has-img");
      FR.$("#ft-preview-empty").hidden = false;
      return;
    }
    try {
      let src;
      if (sample.fileName.toLowerCase().endsWith(".pdf")) {
        if (!pdf) {
          const m = await import("/vendor/pdfjs/build/pdf.min.mjs");
          m.GlobalWorkerOptions.workerSrc =
            "/vendor/pdfjs/build/pdf.worker.min.mjs";
          pdf = await m.getDocument({
            url: `/api/samples/${sample.id}/file`,
            cMapUrl: "/vendor/pdfjs/cmaps/",
            cMapPacked: true,
            standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
            wasmUrl: "/vendor/pdfjs/wasm/",
          }).promise;
        }
        const p = await pdf.getPage(page),
          v = p.getViewport({ scale: 1.5 }),
          canvas = document.createElement("canvas");
        canvas.width = v.width;
        canvas.height = v.height;
        await p.render({
          canvas,
          canvasContext: canvas.getContext("2d"),
          viewport: v,
        }).promise;
        src = canvas.toDataURL("image/png");
      } else src = `/api/samples/${sample.id}/image?page=${page}`;
      if (token !== renderToken) return;
      FR.$("#ft-img").src = src;
      FR.$("#ft-canvas").classList.add("has-img");
      FR.$("#ft-preview-empty").hidden = true;
      renderRects();
    } catch (e) {
      FR.setMsg(FR.$("#ft-msg"), e.message, false);
    }
  }
  /** 열려 있는 샘플 PDF 해제 (pdf.js 문서 객체는 loadingTask 로 해제한다) */
  async function releasePdf() {
    const old = pdf;
    pdf = null;
    if (old) await old.loadingTask.destroy().catch(() => {});
  }
  async function select(id) {
    currentId = id;
    await fill(forms.find((f) => f.id === id));
  }
  async function fill(f) {
    previewToken++;
    await releasePdf();
    sample = null;
    retainedSampleId = f?.sampleId || '';
    page = 1;
    selected = 0;
    selectedGroup = 0;
    FR.$("#ft-name").value = f?.name || "";
    FR.$("#ft-doctype").value = f?.docType || "";
    FR.$("#ft-keywords").value = (f?.keywords || []).join(", ");
    FR.$("#ft-doc-pattern").value = f?.documentRule?.pattern || "";
    FR.$("#ft-doc-except").value = f?.documentRule?.exceptPattern || "";
    FR.$("#ft-engine-options").value = JSON.stringify(
      f?.engineRequest?.reqOption || {},
      null,
      2,
    );
    keys = f ? clone(f.keys) : [emptyKey(1)];
    groups = clone(f?.groups || []);
    FR.$("#ft-msg").textContent = "";
    FR.$("#ft-preview-result").replaceChildren();
    FR.$("#ft-delete").disabled = !currentId;
    if (f?.sampleId && FR.productCapabilities?.samples !== false)
      try {
        sample = await FR.api("GET", `/api/samples/${f.sampleId}`);
      } catch (e) {
        FR.setMsg(FR.$("#ft-msg"), e.message, false);
      }
    renderList();
    renderKeys();
    renderGroups();
    renderSample();
    await versions();
  }
  function collect() {
    let reqOption;
    try {
      reqOption = JSON.parse(FR.$("#ft-engine-options").value || "{}");
    } catch (_) {
      throw new Error("엔진 옵션 JSON을 확인하세요.");
    }
    return {
      name: FR.$("#ft-name").value,
      docType: FR.$("#ft-doctype").value,
      keywords: FR.$("#ft-keywords")
        .value.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      keys,
      groups,
      sampleId: sample?.id || retainedSampleId,
      documentRule: {
        pattern: FR.$("#ft-doc-pattern").value,
        exceptPattern: FR.$("#ft-doc-except").value,
      },
      engineRequest: { reqType: "Document", reqOption },
    };
  }
  async function versions() {
    const list = currentId
      ? await FR.api("GET", `/api/forms/${currentId}/history`)
      : [];
    FR.$("#ft-versions").replaceChildren(
      ...list
        .slice()
        .reverse()
        .map((v) =>
          FR.el(
            "option",
            { value: v.id },
            `v${v.version} · ${FR.fmtTime(v.createdAt)}`,
          ),
        ),
    );
    FR.$("#ft-restore").disabled = !list.length;
  }
  async function load() {
    forms = await FR.api("GET", "/api/forms");
    renderList();
  }
  async function runPreview() {
    const token = ++previewToken,
      button = FR.$("#ft-preview"),
      box = FR.$("#ft-preview-result");
    button.disabled = true;
    try {
      if (!sample) throw new Error("샘플 문서를 먼저 선택하세요.");
      const job = await FR.api("POST", "/api/samples/preview", {
        sampleId: sample.id,
        template: collect(),
      });
      box.textContent = "샘플 OCR 처리 중…";
      for (let i = 0; i < 300 && token === previewToken; i++) {
        const j = await FR.api("GET", `/api/jobs/${job.id}`);
        if (j.status === "done") {
          box.replaceChildren(
            FR.el("strong", {}, "샘플 추출 결과"),
            FR.el(
              "pre",
              {},
              JSON.stringify(
                { values: j.ocrResult.values, groups: j.ocrResult.groups },
                null,
                2,
              ),
            ),
            FR.el(
              "button",
              { onclick: () => FR.formJobView.showResult(j.id) },
              "검수 화면 열기",
            ),
          );
          return;
        }
        if (["failed", "cancelled"].includes(j.status))
          throw new Error(j.error || "취소되었습니다.");
        await FR.sleep(1000);
      }
      if (token === previewToken)
        throw new Error("전체 문서에서 처리 상태를 확인하세요.");
    } catch (e) {
      box.textContent = e.message;
    } finally {
      button.disabled = false;
    }
  }
  function initCanvas() {
    const canvas = FR.$("#ft-canvas"),
      img = FR.$("#ft-img");
    let start = null,
      draft = null;
    const pos = (e) => {
      const r = img.getBoundingClientRect();
      return {
        x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
        y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
      };
    };
    canvas.addEventListener("pointerdown", (e) => {
      if (!sample || !img.complete || !img.naturalWidth) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      start = pos(e);
      draft = FR.el("div", { class: "rect draft" });
      FR.$("#ft-rects").append(draft);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!start) return;
      const p = pos(e);
      Object.assign(draft.style, {
        left: `${Math.min(start.x, p.x) * 100}%`,
        top: `${Math.min(start.y, p.y) * 100}%`,
        width: `${Math.abs(p.x - start.x) * 100}%`,
        height: `${Math.abs(p.y - start.y) * 100}%`,
      });
    });
    canvas.addEventListener("pointerup", (e) => {
      if (!start) return;
      const p = pos(e),
        rect = {
          x: Math.min(start.x, p.x),
          y: Math.min(start.y, p.y),
          w: Math.abs(p.x - start.x),
          h: Math.abs(p.y - start.y),
        };
      start = null;
      draft.remove();
      if (rect.w < 0.003 || rect.h < 0.003) return;
      const target = FR.$("#ft-draw-target").value;
      if (target === "group" && groups[selectedGroup])
        Object.assign(groups[selectedGroup], { rect, page });
      else if (target === "selected" && keys[selected])
        Object.assign(keys[selected], { rect, page });
      else {
        const k = emptyKey(keys.length + 1);
        k.rect = rect;
        keys.push(k);
        selected = keys.length - 1;
      }
      renderKeys();
      renderGroups();
      renderRects();
    });
    canvas.addEventListener("pointercancel", () => {
      start = null;
      draft?.remove();
    });
  }
  return {
    load,
    getForms: () => forms,
    init() {
      initCanvas();
      FR.$("#ft-new").onclick = () => {
        currentId = null;
        fill(null);
      };
      FR.$("#ft-addkey").onclick = () => {
        keys.push(emptyKey(keys.length + 1));
        selected = keys.length - 1;
        renderKeys();
        renderRects();
      };
      FR.$("#ft-addgroup").onclick = () => {
        const c = emptyKey(1);
        c.rect = { x: 0, y: 0, w: 1, h: 1 };
        c.column = 0;
        groups.push({
          name: `group${groups.length + 1}`,
          page,
          rect: { x: 0.05, y: 0.2, w: 0.9, h: 0.6 },
          source: "table",
          tableIndex: 0,
          skipRows: 1,
          rowHeight: 0,
          allPages: false,
          columns: [c],
        });
        selectedGroup = groups.length - 1;
        renderGroups();
        renderRects();
      };
      FR.$("#ft-save").onclick = async () => {
        FR.$("#ft-name").required = FR.$("#ft-doctype").required = true;
        if (!FR.validateFields([FR.$("#ft-name"), FR.$("#ft-doctype")])) {
          FR.setMsg(FR.$("#ft-msg"), "입력 내용을 확인해 주세요.", false);
          return;
        }
        try {
          const f = await FR.api(
            currentId ? "PUT" : "POST",
            currentId ? `/api/forms/${currentId}` : "/api/forms",
            collect(),
          );
          currentId = f.id;
          await load();
          FR.$("#ft-delete").disabled = false;
          await versions();
          FR.setMsg(FR.$("#ft-msg"), `v${f.version} 저장되었습니다.`);
        } catch (e) {
          FR.setMsg(FR.$("#ft-msg"), e.message, false);
        }
      };
      FR.$("#ft-delete").onclick = async () => {
        if (
          !currentId ||
          !confirm("이 서식을 삭제할까요? 기존 OCR 결과는 유지됩니다.")
        )
          return;
        try {
          await FR.api("DELETE", `/api/forms/${currentId}`);
          currentId = null;
          await fill(null);
          await load();
        } catch (e) {
          FR.setMsg(FR.$("#ft-msg"), e.message, false);
        }
      };
      FR.$("#ft-sample").onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          await releasePdf();
          sample = await FR.api("POST", "/api/samples", {
            fileName: file.name,
            contentBase64: await FR.readFileAsBase64(file),
          });
          page = 1;
          await renderSample();
          FR.setMsg(
            FR.$("#ft-msg"),
            "샘플을 보관했습니다. 서식을 저장하면 함께 연결됩니다.",
          );
        } catch (err) {
          FR.setMsg(FR.$("#ft-msg"), err.message, false);
        }
      };
      FR.$("#ft-prev").onclick = () => {
        if (page > 1) {
          page--;
          renderSample();
        }
      };
      FR.$("#ft-next").onclick = () => {
        if (page < (sample?.pageSizes?.length || 1)) {
          page++;
          renderSample();
        }
      };
      FR.$("#ft-preview").onclick = runPreview;
      FR.$("#ft-restore").onclick = async () => {
        if (
          !currentId ||
          !confirm("선택한 버전으로 복원하고 새 버전을 저장할까요?")
        )
          return;
        try {
          const restored = await FR.api("POST", `/api/forms/${currentId}/restore`, {
            versionId: FR.$("#ft-versions").value,
          });
          await load();
          await select(currentId);
          FR.setMsg(FR.$("#ft-msg"), `선택한 버전으로 복원하여 v${restored.version}을 저장했습니다.`);
        } catch (e) {
          FR.setMsg(FR.$("#ft-msg"), e.message, false);
        }
      };
      fill(null);
    },
  };
})();
