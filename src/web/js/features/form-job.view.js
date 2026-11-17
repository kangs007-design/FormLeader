"use strict";
/** 웹 개별기능[form-job]: 문서 업로드(Drag&Drop) / 작업 현황 / 문서 확인(OCR 추출값) 화면 */
FR.formJobView = (() => {
  let timer = null;
  let allText = "";
  const viewer = { view: null, idx: 0, sub: "text" }; // 문서 뷰어(왼쪽) 상태는 FR.docViewer 가 관리
  let currentJob = null;
  let statusFilter = "all";
  let dirty = false;

  const ENGINE_LABEL = {
    AWAITING: "TextSense 대기",
    PROGRESSING: "OCR 진행중",
    SUCCESS: "OCR 완료",
    FAILURE: "OCR 실패",
  };
  const STATUS_LABEL = {
    pending: "대기",
    processing: "처리중",
    done: "완료",
    failed: "실패",
    cancelled: "취소",
  };

  async function loadTemplateOptions() {
    const forms = await FR.api("GET", "/api/forms");
    const sel = FR.$("#jr-template");
    const keep = sel.value;
    sel.replaceChildren(
      FR.el("option", { value: "" }, "자동으로 서식 찾기"),
      ...forms.map((f) =>
        FR.el(
          "option",
          { value: f.id, selected: f.id === keep },
          `${f.name} (${f.docType})`,
        ),
      ),
    );
  }

  /** 작업이 끝날 때까지 1초 간격으로 확인하며 진행 상태를 표시. 완료되면 결과 링크를 붙인다. */
  async function watchJob(id, li, fileName, autoShow) {
    const end = Date.now() + 10 * 60 * 1000;
    while (Date.now() < end) {
      let job;
      try {
        job = await FR.api("GET", `/api/jobs/${id}`);
      } catch (e) {
        li.className = "ng";
        li.textContent = `${fileName} → 상태 조회 실패: ${e.message}`;
        return;
      }
      if (job.status === "done") {
        li.className = "ok";
        li.replaceChildren(
          FR.icon("check-circle"),
          `${fileName} · 인식 완료 `,
          FR.el(
            "button",
            { class: "sm", onclick: () => showResult(id) },
            "결과 보기",
          ),
        );
        if (autoShow) showResult(id);
        return;
      }
      if (job.status === "failed") {
        li.className = "ng";
        li.textContent = `${fileName} → 실패: ${job.error}`;
        return;
      }
      if (job.status === "cancelled") {
        li.textContent = `${fileName} → 취소됨`;
        return;
      }
      li.textContent = `${fileName} → ${ENGINE_LABEL[job.engineStatus] || STATUS_LABEL[job.status]}...`;
      await FR.sleep(1000);
    }
    li.className = "ng";
    li.textContent = `${fileName} → 확인 시간 초과. 작업 현황에서 확인하세요.`;
  }

  const MAX_UPLOAD_MB = 45; // 서버 요청 한도(60MB, Base64 포함)에 맞춘 원본 파일 최대 크기

  async function uploadFiles(files) {
    if (!files.length) return;
    const splitCount = FR.$("#jr-split-count");
    if (!FR.validateFields([splitCount], [
      { input: splitCount, check: (v) => (Number.isInteger(Number(v)) ? "" : "반드시 숫자만 입력하세요.") },
    ])) return;
    FR.$("#jr-progress").hidden = false;
    const log = FR.$("#jr-log");
    const templateId = FR.$("#jr-template").value || undefined;
    for (const file of files) {
      const li = FR.el("li", {}, `${file.name} 업로드 중...`);
      log.prepend(li);
      if (file.size > MAX_UPLOAD_MB * 1048576) {
        li.className = "ng";
        li.textContent = `${file.name} → 파일이 너무 큽니다. 파일당 최대 ${MAX_UPLOAD_MB}MB까지 올릴 수 있습니다.`;
        continue;
      }
      try {
        const job = await FR.api("POST", "/api/jobs", {
          fileName: file.name,
          contentBase64: await FR.readFileAsBase64(file),
          templateId,
          split: {
            mode: FR.$("#jr-split").value,
            count: Number(FR.$("#jr-split-count").value),
          },
        });
        FR.syncJobCount().catch(() => {});
        watchJob(job.id, li, file.name, files.length === 1); // 한 개만 올리면 완료 시 결과 화면으로 자동 이동
      } catch (e) {
        li.className = "ng";
        li.textContent = `${file.name} → 실패: ${e.message}`;
      }
    }
  }

  async function loadStatus() {
    const jobs = await FR.api("GET", "/api/jobs");
    const matchesSearch = FR.makeJobSearchFilter();
    const body = FR.$("#js-body");
    FR.$("#js-count").textContent = jobs.length;
    FR.$("#nav-job-count").textContent = jobs.length;
    const shown = jobs
      .slice()
      .reverse()
      .filter(matchesSearch)
      .filter(
        (j) => statusFilter === "all" || FR.jobStatus(j).group === statusFilter,
      );
    if (!shown.length) {
      body.replaceChildren(
        FR.emptyRow(
          5,
          FR.state.search
            ? "검색어와 일치하는 문서가 없습니다."
            : "이 상태의 문서가 없습니다. 문서를 업로드하고 시작하세요.",
        ),
      );
    } else {
      body.replaceChildren(
        ...shown.map((j) => {
          const st = FR.jobStatus(j);
          return FR.el(
            "tr",
            {},
            FR.el("td", {}, FR.fileCell(j)),
            FR.el(
              "td",
              { class: "error-cell" },
              FR.el(
                "span",
                { class: `pill ${st.cls}`, title: j.error || "" },
                st.label,
              ),
              j.status === "processing" && j.engineStatus
                ? ` ${ENGINE_LABEL[j.engineStatus] || j.engineStatus}`
                : "",
              j.error ? FR.el("span", { class: "job-error" }, j.error) : "",
              j.splitError
                ? FR.el(
                    "span",
                    { class: "job-error" },
                    `분리 실패: ${j.splitError}`,
                  )
                : "",
              j.parentId
                ? FR.el(
                    "span",
                    { class: "split-badge" },
                    j.relation === "split"
                      ? `분리 문서 · 원본 ${j.sourcePages?.join(", ")} 페이지`
                      : "재처리 문서",
                  )
                : "",
              j.cancellation
                ? FR.el("span", { class: "job-error" }, j.cancellation.message)
                : "",
            ),
            FR.el("td", {}, FR.docTypeLabel(j)),
            FR.el("td", {}, FR.shortDate(j.createdAt)),
            FR.el(
              "td",
              {},
              FR.el(
                "div",
                { class: "actions" },
                j.status === "failed"
                  ? FR.el(
                      "button",
                      { class: "sm", onclick: () => FR.showDiagnostics(j.id) },
                      "원인 분석",
                    )
                  : "",
                ["pending", "processing"].includes(j.status)
                  ? FR.el(
                      "button",
                      {
                        class: "sm",
                        onclick: async () => {
                          try {
                            await FR.api(
                              "POST",
                              `/api/jobs/${j.id}/cancel`,
                              {},
                            );
                            await refresh();
                          } catch (e) {
                            alert(e.message);
                          }
                        },
                      },
                      "취소",
                    )
                  : "",
                j.status === "failed"
                  ? FR.el(
                      "button",
                      {
                        class: "sm primary",
                        "aria-label": `${j.fileName} 다시 처리`,
                        onclick: (event) => retryJob(j.id, event.currentTarget),
                      },
                      "다시 처리",
                    )
                  : FR.el(
                      "button",
                      {
                        class: "sm",
                        disabled: j.status !== "done",
                        "aria-label": `${j.fileName} 결과 보기`,
                        onclick: () => showResult(j.id),
                      },
                      "결과 보기",
                    ),
                FR.el(
                  "button",
                  {
                    class: "sm danger",
                    disabled: ["pending", "processing"].includes(j.status),
                    "aria-label": `${j.fileName} 작업 삭제`,
                    onclick: async (event) => {
                      if (!confirm(`“${j.fileName}” 작업 기록을 삭제할까요?`))
                        return;
                      event.currentTarget.disabled = true;
                      try {
                        await FR.api("DELETE", `/api/jobs/${j.id}`);
                        if (currentJob && currentJob.id === j.id) {
                          currentJob = null;
                          dirty = false;
                          FR.$("#or-detail").hidden = true;
                          FR.$("#or-empty").hidden = false;
                        }
                        await refresh();
                      } catch (e) {
                        alert(e.message);
                        event.currentTarget.disabled = false;
                      }
                    },
                  },
                  "삭제",
                ),
              ),
            ),
          );
        }),
      );
    }
    return jobs.some(
      (j) => j.status === "pending" || j.status === "processing",
    );
  }

  async function retryJob(id, button) {
    button.disabled = true;
    try {
      const job = await FR.api("POST", `/api/jobs/${id}/retry`, {});
      const li = FR.el(
        "li",
        {},
        `${job.fileName} · 보관된 원본으로 다시 처리 중...`,
      );
      FR.$("#jr-progress").hidden = false;
      FR.$("#jr-log").prepend(li);
      FR.showTab("job-request");
      FR.syncJobCount().catch(() => {});
      watchJob(job.id, li, job.fileName, true);
    } catch (e) {
      button.disabled = false;
      const cell = button.closest("td");
      let message = cell.querySelector(".retry-error");
      if (!message) {
        message = FR.el("span", {
          class: "job-error retry-error",
          role: "alert",
        });
        cell.append(message);
      }
      message.textContent = e.message;
    }
  }

  const confText = (c) => (c === null || c === undefined ? "" : c.toFixed(2));

  function renderTable(t) {
    return FR.el(
      "div",
      { class: "words-wrap" },
      FR.el(
        "table",
        { class: "grid" },
        FR.el(
          "tbody",
          {},
          t.grid.map((row) =>
            FR.el(
              "tr",
              {},
              row.map((cell) => FR.el("td", {}, cell)),
            ),
          ),
        ),
      ),
    );
  }

  function renderWords(words) {
    return FR.el(
      "div",
      { class: "words-wrap" },
      FR.el(
        "table",
        { class: "grid" },
        FR.el(
          "thead",
          {},
          FR.el(
            "tr",
            {},
            ["#", "텍스트", "신뢰도", "위치 (x1,y1 - x2,y2)"].map((h) =>
              FR.el("th", {}, h),
            ),
          ),
        ),
        FR.el(
          "tbody",
          {},
          words.map((w, i) =>
            FR.el(
              "tr",
              {},
              FR.el("td", {}, i + 1),
              FR.el("td", {}, w.text),
              FR.el(
                "td",
                { class: w.conf !== null && w.conf < 0.6 ? "conf-low" : "" },
                confText(w.conf),
              ),
              FR.el("td", {}, `${w.x1},${w.y1} - ${w.x2},${w.y2}`),
            ),
          ),
        ),
      ),
    );
  }

  /* ---------- 페이지별 추출 결과: 페이지 탭 → (본문 텍스트 / 표 / SearchAPI 필드 / 단어) 하위 탭 ---------- */
  const SUB_TABS = [
    { key: "text", label: "본문 텍스트", count: () => null },
    { key: "tables", label: "표", count: (p) => p.tables.length },
    { key: "fields", label: "추출 필드", count: (p) => p.fields.length },
    { key: "words", label: "단어 목록", count: (p) => p.words.length },
  ];

  /** 탭 버튼 묶음 생성 (role=tablist 접근성 + 좌우 방향키 이동) */
  function buildTabbar(el, items, activeKey, onSelect) {
    el.replaceChildren(
      ...items.map((it) =>
        FR.el(
          "button",
          {
            class: "tabbar-btn",
            role: "tab",
            type: "button",
            "aria-selected": String(it.key === activeKey),
            "data-key": it.key,
            onclick: () => onSelect(it.key),
          },
          it.label,
          it.count !== null && it.count !== undefined
            ? FR.el("span", { class: "count" }, it.count)
            : "",
        ),
      ),
    );
    el.onkeydown = (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const i = items.findIndex((it) => it.key === activeKey);
      const next =
        items[
          (i + (e.key === "ArrowRight" ? 1 : items.length - 1)) % items.length
        ];
      onSelect(next.key);
      const btn = el.querySelector(`[data-key="${next.key}"]`);
      if (btn) btn.focus();
    };
  }

  function renderPageTabs() {
    const pages = viewer.view.pages;
    buildTabbar(
      FR.$("#or-page-tabs"),
      pages.map((p, i) => ({
        key: String(i),
        label: `${p.page} 페이지`,
        count: p.words.length,
      })),
      String(viewer.idx),
      (k) => selectPage(Number(k)),
    );
  }

  /** 선택한 페이지의 하위 탭 + 내용 */
  function renderPagePanel() {
    const p = viewer.view.pages[viewer.idx];
    const panel = FR.$("#or-page-panel");
    const meta = FR.el(
      "p",
      { class: "page-meta" },
      `단어 ${p.words.length}개 · 표 ${p.tables.length}개${p.orientation ? ` · 회전 ${p.orientation * 90}°` : ""} · 좌표 기준 ${p.width}×${p.height}px (${{ image: "이미지 크기", pdf: "PDF 크기", engine: "엔진 크기", estimated: "추정" }[p.sizeSource] || p.sizeSource})`,
    );
    const sub = FR.el("div", {
      class: "tabbar sub",
      role: "tablist",
      "aria-label": "추출 결과 종류",
    });
    buildTabbar(
      sub,
      SUB_TABS.map((t) => ({ key: t.key, label: t.label, count: t.count(p) })),
      viewer.sub,
      (k) => {
        viewer.sub = k;
        renderPagePanel();
      },
    );

    const body = FR.el("div", { role: "tabpanel" });
    if (viewer.sub === "text") {
      body.append(
        FR.el(
          "pre",
          { class: "text" },
          p.content || "(인식된 텍스트가 없습니다)",
        ),
      );
    } else if (viewer.sub === "tables") {
      if (!p.tables.length)
        body.append(
          FR.el(
            "p",
            { class: "panel-empty" },
            "이 페이지에서 인식된 표가 없습니다.",
          ),
        );
      p.tables.forEach((t, i) =>
        body.append(
          FR.el(
            "div",
            { class: "table-title" },
            `표 ${i + 1} (${t.rows}행 × ${t.cols}열)`,
          ),
          renderTable(t),
        ),
      );
    } else if (viewer.sub === "fields") {
      if (!p.fields.length)
        body.append(
          FR.el(
            "p",
            { class: "panel-empty" },
            "이 문서에는 엔진에서 지정한 추출 필드가 없습니다. 서식을 적용하면 필요한 항목을 추출할 수 있습니다.",
          ),
        );
      else
        body.append(
          FR.el(
            "div",
            { class: "table-scroll" },
            FR.el(
              "table",
              { class: "grid" },
              FR.el(
                "tbody",
                {},
                p.fields.map((f) =>
                  FR.el(
                    "tr",
                    {},
                    FR.el("td", {}, f.name),
                    FR.el("td", {}, f.text),
                  ),
                ),
              ),
            ),
          ),
        );
    } else {
      body.append(
        p.words.length
          ? renderWords(p.words)
          : FR.el("p", { class: "panel-empty" }, "인식된 단어가 없습니다."),
      );
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
    const banner = FR.$("#or-banner");
    const pill = FR.$("#or-doctype");
    const box = FR.$("#or-fields");
    box.replaceChildren();
    const markDirty = () => {
      dirty = true;
      FR.setMsg(
        FR.$("#or-save-msg"),
        "저장하지 않은 변경사항이 있습니다.",
        false,
      );
    };
    FR.$("#or-review-actions").hidden = false;
    FR.$("#or-confirm").checked = !!(job.review && job.review.confirmed);
    FR.$("#or-save-msg").textContent = job.review
      ? `마지막 저장 ${FR.fmtTime(job.review.savedAt)}`
      : "";

    if (r.classified) {
      const confirmed = job.review && job.review.confirmed;
      const needsReview =
        r.needsReview ||
        (job.review &&
          Object.values(job.review.values || {}).some((field) => !field.valid));
      banner.className = `banner ${confirmed || !needsReview ? "ok" : "warn"}`;
      banner.replaceChildren(
        FR.icon(confirmed || !needsReview ? "check-circle" : "alert"),
        confirmed
          ? "검수가 완료된 문서입니다."
          : "원본과 비교한 뒤 필요한 값을 수정하세요.",
      );
      pill.textContent = r.docType;
      Object.entries(r.values).forEach(([name, v]) => {
        const saved =
          (job.review && job.review.values && job.review.values[name]) || v;
        const input = FR.el("input", {
          value: saved.value,
          class: saved.valid ? "" : "invalid",
          "data-review-key": name,
          "aria-label": name,
          oninput: markDirty,
          maxlength: 50000,
        });
        box.append(
          FR.el(
            "label",
            { class: "field" },
            FR.el("span", { class: "field-label" }, name),
            input,
            FR.el(
              "span",
              { class: "field-original" },
              `OCR 원본: ${v.value || "(인식된 값 없음)"}`,
            ),
            saved.valid
              ? ""
              : FR.el("span", { class: "field-err" }, saved.errors.join(", ")),
          ),
        );
      });
      for (const [name, original] of Object.entries(r.groups || {})) {
        const group = job.review?.groups?.[name] || original;
        box.append(
          FR.el(
            "div",
            { class: "review-group" },
            FR.el("strong", {}, `${name} · ${group.rows.length}행`),
            FR.el(
              "table",
              { class: "grid" },
              FR.el(
                "thead",
                {},
                FR.el(
                  "tr",
                  {},
                  ["페이지", ...group.columns].map((c) => FR.el("th", {}, c)),
                ),
              ),
              FR.el(
                "tbody",
                {},
                group.rows.map((row, i) =>
                  FR.el(
                    "tr",
                    {},
                    FR.el("td", {}, row.page),
                    ...group.columns.map((c) =>
                      FR.el(
                        "td",
                        {},
                        FR.el("input", {
                          value: row.values[c]?.value || "",
                          class: row.values[c]?.valid ? "" : "invalid",
                          "data-review-group": name,
                          "data-review-row": i,
                          "data-review-column": c,
                          "aria-label": `${name} ${i + 1}행 ${c}`,
                          oninput: markDirty,
                          maxlength: 50000,
                        }),
                        row.values[c]?.errors?.length
                          ? FR.el(
                              "small",
                              { class: "field-err" },
                              row.values[c].errors.join(", "),
                            )
                          : "",
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      }
    } else {
      banner.className = `banner ${job.review && job.review.confirmed ? "ok" : "info"}`;
      banner.replaceChildren(
        FR.icon("check-circle"),
        job.review && job.review.confirmed
          ? "본문 검수가 완료되었습니다."
          : "서식과 일치하는 문서 유형을 찾지 못했습니다. 본문을 확인하거나 서식을 등록하세요.",
      );
      pill.textContent = "미분류";
      box.append(
        FR.el(
          "label",
          { class: "field" },
          FR.el(
            "span",
            { class: "field-label" },
            "인식한 본문 · 직접 수정할 수 있습니다",
          ),
          FR.el(
            "textarea",
            {
              id: "or-review-text",
              rows: 12,
              maxlength: 5000000,
              "aria-label": "인식 본문 수정",
              oninput: markDirty,
            },
            job.review && job.review.text !== undefined
              ? job.review.text
              : allText,
          ),
        ),
      );
    }

    const words = view.pages
      .flatMap((p) => p.words)
      .filter((w) => w.conf !== null);
    const avg = words.length
      ? (words.reduce((a, w) => a + w.conf, 0) / words.length).toFixed(2)
      : "-";
    const dl = FR.el("dl", { class: "summary-list" });
    [
      ["페이지", `${r.pageCount}장`],
      ["인식한 단어", `${r.wordCount}개`],
      ["표", `${r.tableCount}개`],
      ["평균 신뢰도", avg],
      ["처리 시각", FR.fmtTime(job.updatedAt)],
    ].forEach(([k, v]) => dl.append(FR.el("dt", {}, k), FR.el("dd", {}, v)));
    box.append(
      FR.el(
        "div",
        { class: "field" },
        FR.el("span", { class: "field-label" }, "인식 요약"),
        dl,
      ),
    );
  }

  async function showResult(id) {
    if (
      dirty &&
      currentJob &&
      !confirm(
        "저장하지 않은 검수 내용이 있습니다. 변경사항을 버리고 문서를 열까요?",
      )
    )
      return;
    FR.$("#or-copy-msg").textContent = "";
    try {
      const [job, view] = await Promise.all([
        FR.api("GET", `/api/jobs/${id}`),
        FR.api("GET", `/api/jobs/${id}/ocr`),
      ]);
      currentJob = job;
      dirty = false;
      FR.$("#or-empty").hidden = true;
      FR.$("#or-detail").hidden = false;
      FR.$("#or-title").textContent = job.fileName;
      FR.$("#or-meta").textContent =
        `${job.ocrResult.pageCount}페이지 · ${job.ocrResult.wordCount}단어 · ${FR.fmtTime(job.updatedAt)}`;
      FR.showTab("ocr-result"); // 화면을 먼저 보이게 해야 뷰어가 실제 폭을 측정해서 문서를 그린다

      Object.assign(viewer, { view, idx: 0, sub: "text" });
      FR.docViewer.open({ jobId: id, fileName: job.fileName, view }); // 원본 문서 뷰어 준비
      allText = view.pages
        .map(
          (p) =>
            (view.pages.length > 1 ? `[${p.page} 페이지]\n` : "") + p.content,
        )
        .join("\n\n");
      renderFields(job, view);
      selectPage(0); // 문서 뷰어 + 페이지 탭 + 상세 내용

      FR.$("#or-json").textContent = JSON.stringify(
        { ocr: job.ocrResult, review: job.review || null },
        null,
        2,
      );
      const forms = await FR.api("GET", "/api/forms");
      FR.$("#or-reapply-form").replaceChildren(
        FR.el("option", { value: "" }, "자동으로 서식 찾기"),
        ...forms.map((f) =>
          FR.el(
            "option",
            { value: f.id, selected: f.id === job.ocrResult.templateId },
            `${f.name} · v${f.version || 1}`,
          ),
        ),
      );
      FR.$("#or-history").replaceChildren(
        FR.el(
          "ul",
          { class: "history-list" },
          ...(job.events || []).map((e) =>
            FR.el(
              "li",
              {},
              `${FR.fmtTime(e.at)} · ${FR.eventLabel(e.type)}${e.message ? ` · ${e.message}` : ""}`,
            ),
          ),
        ),
        ...(job.children || []).map((child) =>
          FR.el(
            "button",
            { class: "sm", onclick: () => showResult(child) },
            "분리 문서 보기",
          ),
        ),
        job.parentId
          ? FR.el(
              "button",
              { class: "sm", onclick: () => showResult(job.parentId) },
              "원본 작업 보기",
            )
          : "",
      );
    } catch (e) {
      FR.$("#or-detail").hidden = true;
      FR.$("#or-empty").hidden = false;
      FR.$("#or-empty").replaceChildren(
        FR.el(
          "p",
          { class: "msg ng" },
          `결과를 불러올 수 없습니다: ${e.message}`,
        ),
      );
    }
    FR.showTab("ocr-result");
  }

  /** 처리 중인 작업이 있으면 2초마다 현황 갱신 */
  function schedulePoll(active) {
    clearTimeout(timer);
    if (active)
      timer = FR.pollTab("job-status", 2000, refresh);
  }
  /** 전체 문서 검색: 파일명·문서 유형은 즉시, 본문(2자 이상)은 서버 검색으로 반영. 최신 입력만 적용한다 */
  function initSearch() {
    let seq = 0;
    const apply = FR.debounce(async () => {
      const mine = ++seq;
      const q = FR.state.search.trim();
      let ids = [];
      if (q.length >= 2) {
        try {
          ids = await FR.api("GET", `/api/jobs/search?q=${encodeURIComponent(q)}`);
        } catch (_) {
          /* 본문 검색 실패 시 파일명 검색만 적용 */
        }
      }
      if (mine !== seq) return;
      FR.state.contentIds = new Set(ids);
      refresh();
    }, 250);
    FR.$("#js-search").addEventListener("input", (e) => {
      FR.state.search = e.target.value;
      apply();
    });
  }
  async function refresh() {
    try {
      schedulePoll(await loadStatus());
    } catch (e) {
      FR.$("#js-body").replaceChildren(
        FR.emptyRow(5, `문서를 불러오지 못했습니다: ${e.message}`),
      );
    }
  }

  async function saveReview() {
    if (!currentJob) return;
    const button = FR.$("#or-save");
    button.disabled = true;
    try {
      const values = Object.fromEntries(
        [...FR.$("#or-fields").querySelectorAll("[data-review-key]")].map(
          (input) => [input.dataset.reviewKey, input.value],
        ),
      );
      const groups = {};
      FR.$("#or-fields")
        .querySelectorAll("[data-review-group]")
        .forEach((input) => {
          const g = input.dataset.reviewGroup,
            i = Number(input.dataset.reviewRow);
          if (!groups[g]) groups[g] = [];
          if (!groups[g][i]) groups[g][i] = {};
          groups[g][i][input.dataset.reviewColumn] = input.value;
        });
      const text = FR.$("#or-review-text");
      currentJob = await FR.api("PUT", `/api/jobs/${currentJob.id}/review`, {
        values,
        groups,
        ...(text ? { text: text.value } : {}),
        confirmed: FR.$("#or-confirm").checked,
      });
      dirty = false;
      renderFields(currentJob, viewer.view);
      FR.$("#or-json").textContent = JSON.stringify(
        { ocr: currentJob.ocrResult, review: currentJob.review },
        null,
        2,
      );
      FR.setMsg(
        FR.$("#or-save-msg"),
        currentJob.review.confirmed
          ? "검수를 완료하고 저장했습니다."
          : "수정한 내용을 임시 저장했습니다.",
      );
    } catch (e) {
      FR.setMsg(FR.$("#or-save-msg"), e.message, false);
    } finally {
      button.disabled = false;
    }
  }

  async function exportResult() {
    if (!currentJob) return;
    if (dirty) {
      FR.setMsg(
        FR.$("#or-save-msg"),
        "변경한 내용을 먼저 저장한 뒤 내보내 주세요.",
        false,
      );
      return;
    }
    const format = FR.$("#or-export-format").value;
    const stem = currentJob.fileName.replace(/\.[^.]+$/, "");
    const button = FR.$("#or-export");
    button.disabled = true;
    try {
      const res = await fetch(
        `/api/jobs/${currentJob.id}/export?format=${encodeURIComponent(format)}`,
      );
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.error?.message || "내보내기에 실패했습니다.");
      }
      FR.download(
        `${stem}.${format}`,
        await res.blob(),
        res.headers.get("Content-Type"),
      );
    } catch (e) {
      FR.setMsg(FR.$("#or-save-msg"), e.message, false);
    } finally {
      button.disabled = false;
    }
  }

  return {
    refresh,
    loadTemplateOptions,
    showResult,
    init() {
      const drop = FR.$("#jr-drop");
      const input = FR.$("#jr-file");
      drop.addEventListener("click", () => input.click());
      drop.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          input.click();
        }
      });
      input.addEventListener("change", () => {
        uploadFiles([...input.files]);
        input.value = "";
      });
      FR.$("#jr-split").onchange = () =>
        (FR.$("#jr-split-count-label").hidden =
          FR.$("#jr-split").value !== "pages");
      ["dragenter", "dragover"].forEach((ev) =>
        drop.addEventListener(ev, (e) => {
          e.preventDefault();
          drop.classList.add("over");
        }),
      );
      ["dragleave", "drop"].forEach((ev) =>
        drop.addEventListener(ev, (e) => {
          e.preventDefault();
          drop.classList.remove("over");
        }),
      );
      drop.addEventListener("drop", (e) =>
        uploadFiles([...e.dataTransfer.files]),
      );
      FR.$("#js-refresh").addEventListener("click", refresh);
      initSearch();
      FR.$("#js-filters").addEventListener("click", (event) => {
        const button = event.target.closest("[data-filter]");
        if (!button) return;
        statusFilter = button.dataset.filter;
        FR.$("#js-filters")
          .querySelectorAll("button")
          .forEach((b) => {
            b.classList.toggle("active", b === button);
            b.setAttribute("aria-pressed", String(b === button));
          });
        refresh();
      });
      FR.$("#or-save").addEventListener("click", saveReview);
      FR.$("#or-export").addEventListener("click", exportResult);
      const action = async (fn) => {
        if (!currentJob) return;
        if (dirty) {
          FR.setMsg(
            FR.$("#or-action-msg"),
            "변경한 검수 내용을 먼저 저장하세요.",
            false,
          );
          return;
        }
        try {
          await fn();
        } catch (e) {
          FR.setMsg(FR.$("#or-action-msg"), e.message, false);
        }
      };
      FR.$("#or-reapply").onclick = () =>
        action(async () => {
          if (!confirm("서식을 재적용하고 기존 검수값을 초기화할까요?")) return;
          await FR.api("POST", `/api/jobs/${currentJob.id}/reapply`, {
            templateId: FR.$("#or-reapply-form").value || null,
          });
          await showResult(currentJob.id);
          FR.setMsg(FR.$("#or-action-msg"), "서식을 재적용했습니다.");
        });
      FR.$("#or-split").onclick = () =>
        action(async () => {
          const groupsInput = FR.$("#or-split-groups");
          let groups;
          const valid = FR.validateFields([groupsInput], [
            { input: groupsInput, check: (v) => { try { groups = FR.parsePageGroups(v); return ""; } catch (e) { return e.message; } } },
          ]);
          if (!valid) return;
          const children = await FR.api(
            "POST",
            `/api/jobs/${currentJob.id}/split`,
            { groups },
          );
          await showResult(currentJob.id);
          await FR.syncJobCount();
          FR.setMsg(
            FR.$("#or-action-msg"),
            `${children.length}개 문서로 분리했습니다. 작업 이력에서 열 수 있습니다.`,
          );
        });
      FR.$("#or-deliver").onclick = () =>
        action(async () => {
          const r = await FR.api(
            "POST",
            `/api/jobs/${currentJob.id}/deliver`,
            {},
          );
          FR.setMsg(
            FR.$("#or-action-msg"),
            r.status === "sent"
              ? "업무 서버에 전송했습니다."
              : `전송 실패: ${r.error}`,
            r.status === "sent",
          );
        });
      FR.$("#or-confirm").addEventListener("change", () => {
        dirty = true;
        FR.setMsg(FR.$("#or-save-msg"), "검수 상태를 저장해 주세요.", false);
      });
      window.addEventListener("beforeunload", (e) => {
        if (dirty) {
          e.preventDefault();
          e.returnValue = "";
        }
      });

      FR.$("#or-prev").addEventListener("click", () =>
        selectPage(viewer.idx - 1),
      );
      FR.$("#or-next").addEventListener("click", () =>
        selectPage(viewer.idx + 1),
      );
      FR.docViewer.init();
      FR.$("#or-back").addEventListener("click", () =>
        FR.showTab("job-status"),
      );
      FR.$("#or-goto-form").addEventListener("click", () =>
        FR.showTab("form-template"),
      );

      FR.$("#or-copy").addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(
            FR.$("#or-review-text")
              ? FR.$("#or-review-text").value
              : currentJob &&
                  currentJob.review &&
                  currentJob.review.text !== undefined
                ? currentJob.review.text
                : allText,
          );
          FR.setMsg(FR.$("#or-copy-msg"), "복사되었습니다.");
        } catch (_) {
          FR.setMsg(
            FR.$("#or-copy-msg"),
            "복사 실패 - 본문 텍스트를 직접 선택해 복사하세요.",
            false,
          );
        }
      });
    },
  };
})();
