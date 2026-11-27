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
  /** 나눠서 처리하는 문서의 진행 상황 */
  const progressText = (job) =>
    job.progress
      ? ` ${job.progress.done.toLocaleString()} / ${job.progress.total.toLocaleString()}페이지`
      : "";
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

  /** 작업이 끝날 때까지 확인하며 진행 상태를 표시. 완료되면 결과 링크를 붙인다. (대용량 문서는 몇 시간 걸릴 수 있다) */
  async function watchJob(id, li, fileName, autoShow) {
    const started = Date.now();
    let errors = 0;
    while (li.isConnected) {
      const long = Date.now() - started > 120000;
      let job;
      try {
        job = await FR.api("GET", `/api/jobs/${id}`);
        errors = 0;
      } catch (e) {
        if (++errors < 30 && e.code !== "NOT_FOUND") {
          await FR.sleep(5000);
          continue;
        }
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
        // 오래 걸린 작업은 다른 일을 하는 중일 수 있으므로 화면을 옮기지 않는다
        if (autoShow && !long && FR.isTabActive("job-request")) showResult(id);
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
      const pages = job.pageSizes?.length || 0;
      const minutes = Math.floor((Date.now() - started) / 60000);
      li.textContent =
        `${fileName} → ${ENGINE_LABEL[job.engineStatus] || STATUS_LABEL[job.status]}...` +
        progressText(job) +
        (pages > 100 ? ` (${pages.toLocaleString()}페이지 · 대용량 문서는 몇 시간 걸릴 수 있으며 다른 화면을 사용해도 계속 처리됩니다)` : "") +
        (minutes ? ` · ${minutes}분 경과` : "");
      await FR.sleep(long ? 5000 : 1000);
    }
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

  const isAdmin = () => FR.currentUser?.role === "admin";
  const columnCount = () => (isAdmin() ? 6 : 5);

  /** 관리자 목록의 "작업자" 칸 (문서를 올린 계정) */
  const ownerCell = (job) =>
    FR.el(
      "td",
      { class: "owner-cell", "data-label": "작업자" },
      job.owner
        ? [
            FR.el("span", { class: "owner-name" }, job.owner.name),
            FR.el("span", { class: "owner-email", title: job.owner.email }, job.owner.email),
          ]
        : FR.el("span", { class: "owner-email" }, "기록 없음"),
    );

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
          columnCount(),
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
              { class: "error-cell", "data-label": "상태" },
              FR.el(
                "span",
                { class: `pill ${st.cls}`, title: j.error || "" },
                st.label,
              ),
              j.status === "processing" && j.engineStatus
                ? ` ${j.progress ? progressText(j).trim() : ENGINE_LABEL[j.engineStatus] || j.engineStatus}`
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
                    { class: j.relation === "split" ? "split-badge" : "retry-note" },
                    j.relation === "split"
                      ? `분리 문서 · 원본 ${j.sourcePages?.join(", ")} 페이지`
                      : "재처리 문서",
                  )
                : "",
              j.cancellation
                ? FR.el("span", { class: "job-error" }, j.cancellation.message)
                : "",
            ),
            ...(isAdmin() ? [ownerCell(j)] : []),
            FR.el("td", { "data-label": "문서 유형" }, FR.docTypeLabel(j)),
            FR.el("td", { "data-label": "등록일" }, FR.shortDate(j.createdAt)),
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

  const wordCountOf = (p) => (p.words ? p.words.length : p.wordCount);

  function renderPageTabs() {
    const pages = viewer.view.pages;
    // 페이지가 많으면 현재 페이지 주변과 처음·끝만 탭으로 만들고, 번호로 바로 이동하게 한다
    const many = pages.length > 50;
    const shown = pages
      .map((p, i) => ({ p, i }))
      .filter(({ i }) => !many || i === 0 || i === pages.length - 1 || Math.abs(i - viewer.idx) <= 5);
    const bar = FR.$("#or-page-tabs");
    buildTabbar(
      bar,
      shown.map(({ p, i }) => ({
        key: String(i),
        label: `${p.page} 페이지`,
        count: wordCountOf(p),
      })),
      String(viewer.idx),
      (k) => selectPage(Number(k)),
    );
    if (!many) return;
    bar.prepend(
      FR.el(
        "label",
        { class: "page-jump" },
        "페이지 이동",
        FR.el("input", {
          type: "number",
          min: 1,
          max: pages.length,
          value: viewer.idx + 1,
          "aria-label": `이동할 페이지 (1~${pages.length})`,
          onkeydown: (e) => e.stopPropagation(),
          onchange: (e) => selectPage(Math.min(pages.length, Math.max(1, Math.floor(Number(e.target.value)) || 1)) - 1),
        }),
        `/ ${pages.length}`,
      ),
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
  async function selectPage(i) {
    const view = viewer.view;
    if (!view || i < 0 || i >= view.pages.length) return;
    viewer.idx = i;
    const p = view.pages[i];
    if (!p.words) {
      // 대용량 문서: 선택한 페이지의 상세만 불러온다
      renderPageTabs();
      FR.$("#or-page-panel").replaceChildren(FR.el("p", { class: "panel-empty" }, `${p.page} 페이지를 불러오는 중...`));
      try {
        Object.assign(p, await FR.api("GET", `/api/jobs/${view.jobId}/ocr/pages/${p.page}`));
      } catch (e) {
        if (viewer.view === view && viewer.idx === i)
          FR.$("#or-page-panel").replaceChildren(FR.el("p", { class: "msg ng" }, `페이지를 불러오지 못했습니다: ${e.message}`));
        return;
      }
      if (viewer.view !== view || viewer.idx !== i) return;
    }
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
    } else if (view.lazy && allText.length > 1000000) {
      banner.className = "banner info";
      banner.replaceChildren(
        FR.icon("check-circle"),
        "본문이 커서 화면에서 한 번에 수정할 수 없습니다. 페이지별로 확인하고, 수정이 필요하면 내보내기를 이용하세요.",
      );
      pill.textContent = "미분류";
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

    let sum = 0;
    let count = 0;
    for (const p of view.pages) {
      if (view.lazy) {
        sum += p.confSum;
        count += p.confCount;
      } else
        for (const w of p.words)
          if (w.conf !== null) {
            sum += w.conf;
            count += 1;
          }
    }
    // 서버 검증 오류 문구도 입력칸보다 1pt 작게
    FR.$("#or-fields").querySelectorAll(".field-err").forEach((node) => {
      const input = node.parentElement.querySelector("input");
      if (input) FR.fitErrorText(node, input);
    });
    const avg = count ? (sum / count).toFixed(2) : "-";
    FR.$("#or-summary").replaceChildren(
      ...[
      ["페이지", `${r.pageCount}장`],
      ["인식한 단어", `${r.wordCount}개`],
      ["표", `${r.tableCount}개`],
      ["평균 신뢰도", avg],
      ["처리 시각", FR.fmtTime(job.updatedAt)],
      ].map(([k, v]) => FR.el("div", {}, FR.el("dt", {}, k), FR.el("dd", {}, v))),
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
      // 이전 문서(또는 이전 작업)의 입력 오류·결과 메시지를 남기지 않는다
      FR.resetNotices(FR.$("#tab-ocr-result"));
      FR.$("#or-split-groups").value = "";
      FR.$("#or-empty").hidden = true;
      FR.$("#or-detail").hidden = false;
      FR.$("#or-title").textContent = job.fileName;
      FR.$("#or-meta").textContent =
        `${job.ocrResult.pageCount}페이지 · ${job.ocrResult.wordCount}단어 · ${FR.fmtTime(job.updatedAt)}`;
      FR.showTab("ocr-result"); // 화면을 먼저 보이게 해야 뷰어가 실제 폭을 측정해서 문서를 그린다

      view.jobId = id;
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
      FR.showTab("ocr-result");
    }
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
        FR.emptyRow(columnCount(), `문서를 불러오지 못했습니다: ${e.message}`),
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
        baseSavedAt: currentJob.review?.savedAt || null,
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
        FR.resetNotices(FR.$("#tab-ocr-result"));
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
