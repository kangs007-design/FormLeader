"use strict";
FR.eventLabel = (type) =>
  ({
    created: "작업 등록",
    "status.processing": "인식 시작",
    "status.done": "인식 완료",
    "status.failed": "인식 실패",
    "status.cancelled": "작업 취소",
    "review.saved": "검수 저장",
    "template.reapplied": "서식 재적용",
    "document.split": "문서 분리",
    "split.created": "분리 문서 생성",
    "split.failed": "문서 분리 실패",
    "delivery.failed": "업무 전송 실패",
    "engine.AWAITING": "엔진 대기",
    "engine.PROGRESSING": "엔진 처리 중",
    "engine.SUCCESS": "엔진 처리 완료",
    "engine.FAILURE": "엔진 처리 실패",
  })[type] || "작업 갱신";
FR.parsePageGroups = (text) =>
  text.split(";").map((group) =>
    group.split(",").flatMap((part) => {
      const s = part.trim();
      if (!/^\d+(-\d+)?$/.test(s))
        throw new Error("페이지는 1-2;3-4;5 형식으로 입력하세요.");
      const [a, b] = s.split("-").map(Number);
      if (b !== undefined && (b < a || b - a > 10000))
        throw new Error("페이지 범위가 올바르지 않습니다.");
      return b === undefined
        ? [a]
        : Array.from({ length: b - a + 1 }, (_, i) => a + i);
    }),
  );
FR.showDiagnostics = async (id) => {
  try {
    const d = await FR.api("GET", `/api/jobs/${id}/diagnostics`);
    let dialog = FR.$("#diagnostics-dialog");
    if (!dialog) {
      dialog = FR.el("dialog", {
        id: "diagnostics-dialog",
        class: "profile-dialog",
      });
      document.body.append(dialog);
    }
    dialog.replaceChildren(
      FR.el(
        "div",
        { class: "dialog-head" },
        FR.el("h2", {}, "작업 원인 분석"),
        FR.el(
          "button",
          { "aria-label": "원인 분석 닫기", onclick: () => dialog.close() },
          "닫기",
        ),
      ),
      FR.el("strong", {}, d.fileName),
      FR.el(
        "p",
        {},
        `원본 ${d.sourcePresent ? "보관됨" : "없음"} · 결과 ${d.resultPresent ? "수신됨" : "없음"} · 전체 ${(d.totalElapsedMs / 1000).toFixed(1)}초`,
      ),
      FR.el(
        "p",
        { class: "msg ng" },
        [d.errorCode, d.error].filter(Boolean).join(": "),
      ),
      ...d.hints.map((h) => FR.el("p", {}, h)),
      FR.el(
        "ul",
        { class: "history-list" },
        d.stages.map((e) =>
          FR.el(
            "li",
            {},
            `${FR.fmtTime(e.at)} · ${FR.eventLabel(e.type)} · 이전 단계 후 ${(e.elapsedMs / 1000).toFixed(1)}초`,
          ),
        ),
      ),
    );
    dialog.showModal();
  } catch (e) {
    alert(e.message);
  }
};

FR.operationsView = (() => {
  let timer = null;
  const bytes = (n) => `${(n / 1024 ** 3).toFixed(1)} GB`;
  const table = (headers, rows) =>
    FR.el(
      "table",
      { class: "grid" },
      FR.el(
        "thead",
        {},
        FR.el(
          "tr",
          {},
          headers.map((h) => FR.el("th", {}, h)),
        ),
      ),
      FR.el(
        "tbody",
        {},
        rows.map((row) =>
          FR.el(
            "tr",
            {},
            row.map((v) => FR.el("td", {}, v)),
          ),
        ),
      ),
    );
  async function refresh() {
    clearTimeout(timer);
    try {
      const m = await FR.api("GET", "/api/workspace/monitor");
      FR.$("#op-metrics").replaceChildren(
        ...[
          ["CPU", `${m.local.cpuPercent.toFixed(1)}%`],
          [
            "RAM",
            `${bytes(m.local.memory.used)} / ${bytes(m.local.memory.total)}`,
          ],
          ["저장소 여유", bytes(m.local.storage.free)],
          ["처리 중", `${m.jobs.processing}건`],
        ].map(([label, value]) =>
          FR.el(
            "div",
            { class: "stat-card" },
            FR.el("div", { class: "stat-label" }, label),
            FR.el("strong", { class: "metric-value" }, value),
          ),
        ),
      );
      FR.$("#op-services").replaceChildren(
        FR.el(
          "p",
          {},
          `앱 서버 ${m.local.host}: 실행 중 · OCR 게이트웨이 TCP: ${m.services.gateway.reachable ? "연결 가능" : `연결 실패 (${m.services.gateway.error})`} · 수집 ${FR.fmtTime(m.at)}`,
        ),
        FR.el(
          "p",
          { class: "hint" },
          "자원 사용량은 앱 서버 기준입니다. 게이트웨이 TCP 연결 여부는 OCR 처리 성공 여부와 별도로 확인합니다.",
        ),
        m.remote.configured
          ? FR.el(
              "pre",
              {},
              JSON.stringify(
                m.remote.metrics || { error: m.remote.error },
                null,
                2,
              ),
            )
          : FR.el(
              "p",
              { class: "hint" },
              "원격 OCR 서버 지표 URL이 설정되지 않았습니다.",
            ),
      );
      FR.$("#op-failures").replaceChildren(
        ...m.failures.map((f) =>
          FR.el(
            "p",
            {},
            FR.el(
              "button",
              { class: "sm", onclick: () => FR.showDiagnostics(f.id) },
              f.fileName,
            ),
            ` ${f.code || ""} ${f.error}`,
          ),
        ),
        ...m.deliveries.map((d) =>
          FR.el(
            "p",
            {},
            `${d.jobId}: ${d.status === "sent" ? "전송 완료" : d.status === "failed" ? "전송 실패" : "전송 중"} · ${d.attempts}회 ${d.error || ""}`,
            d.status === "failed"
              ? FR.el(
                  "button",
                  {
                    class: "sm",
                    onclick: async () => {
                      await FR.api("POST", `/api/jobs/${d.jobId}/deliver`, {});
                      await refresh();
                    },
                  },
                  "다시 전송",
                )
              : "",
          ),
        ),
      );
      FR.$("#op-events").replaceChildren(
        table(
          ["일시", "문서", "이벤트", "사용자"],
          m.events.map((e) => [
            FR.fmtTime(e.at),
            e.fileName,
            FR.eventLabel(e.type),
            e.actorName || "시스템",
          ]),
        ),
      );
    } catch (e) {
      FR.setMsg(FR.$("#op-msg"), e.message, false);
    } finally {
      if (FR.$("#tab-operations").classList.contains("active"))
        timer = setTimeout(refresh, 10000);
    }
  }
  async function load() {
    const s = await FR.api("GET", "/api/workspace/settings");
    FR.$("#op-policy").value = JSON.stringify(s.engine, null, 2);
    FR.$("#op-url").value = s.integration.url;
    FR.$("#op-monitor-url").value = s.integration.monitorUrl;
    FR.$("#op-token").placeholder = s.integration.tokenConfigured
      ? "토큰 저장됨 · 빈칸이면 유지"
      : "토큰 없음";
    FR.$("#op-token").value = "";
    FR.$("#op-auto-send").checked = s.integration.autoSend;
    FR.$("#op-capabilities").textContent =
      `PDF 좌표 배율 ${s.capabilities.pdfOcrScale} · ${s.capabilities.cancelConfigured ? "엔진 중단 요청 경로 설정됨" : "엔진 중단 요청 경로 미설정: 앱 후속 처리만 취소"} · 엔진 영구 정책 저장 API는 제공된 매뉴얼에 없습니다.`;
    await refresh();
  }
  async function act(fn) {
    try {
      await fn();
      await load(); // 저장된 값 기준으로 입력칸(토큰 등)과 안내를 갱신
      FR.setMsg(FR.$("#op-msg"), "저장되었습니다.");
    } catch (e) {
      FR.setMsg(FR.$("#op-msg"), e.message, false);
    }
  }
  return {
    load,
    init() {
      FR.$("#op-refresh").onclick = refresh;
      FR.$("#op-save-policy").onclick = () => {
        const policy = FR.$("#op-policy");
        let engine;
        const valid = FR.validateFields([], [
          { input: policy, check: (v) => { try { engine = JSON.parse(v); return ""; } catch (_) { return "올바른 JSON 형식으로 입력하세요."; } } },
        ]);
        if (!valid) return;
        act(() => FR.api("PUT", "/api/workspace/settings", { engine }));
      };
      FR.$("#op-save-integration").onclick = () => {
        if (!FR.validateFields([FR.$("#op-url"), FR.$("#op-monitor-url")])) return;
        act(() =>
          FR.api("PUT", "/api/workspace/settings", {
            integration: {
              url: FR.$("#op-url").value,
              monitorUrl: FR.$("#op-monitor-url").value,
              autoSend: FR.$("#op-auto-send").checked,
              ...(FR.$("#op-token").value
                ? { token: FR.$("#op-token").value }
                : {}),
            },
          }),
        );
      };
      FR.$("#op-reset").onclick = async () => {
        const confirmInput = FR.$("#op-reset-confirm");
        if (!FR.validateFields([], [
          { input: confirmInput, check: (v) => (v.trim() === "문서 초기화" ? "" : "확인 문구로 '문서 초기화'를 정확히 입력하세요.") },
        ])) return;
        if (!confirm("선택한 문서 데이터를 영구 삭제할까요?")) return;
        try {
          const r = await FR.api("POST", "/api/workspace/reset", {
            confirm: FR.$("#op-reset-confirm").value,
            includeTemplates: FR.$("#op-reset-forms").checked,
          });
          FR.$("#op-reset-confirm").value = "";
          FR.setMsg(
            FR.$("#op-msg"),
            `${r.removedJobs}개 문서를 초기화했습니다. 사용자 계정은 유지했습니다.`,
          );
          await FR.syncJobCount();
          await refresh();
        } catch (e) {
          FR.setMsg(FR.$("#op-msg"), e.message, false);
        }
      };
    },
  };
})();

FR.compareView = (() => {
  let jobs = [],
    comparisons = [],
    current = null,
    pdfjs = null,
    docs = {},
    renderSeq = { left: 0, right: 0 };
  const label = {
    added: "추가",
    removed: "삭제",
    changed: "변경",
    moved: "위치 변경",
    pages: "페이지 수 변경",
  };
  async function load() {
    jobs = (await FR.api("GET", "/api/jobs")).filter(
      (j) => j.status === "done",
    );
    for (const side of ["left", "right"]) {
      const el = FR.$(`#cp-${side}`),
        keep = el.value;
      el.replaceChildren(
        FR.el("option", { value: "" }, "문서 선택"),
        ...jobs.map((j) =>
          FR.el("option", { value: j.id, selected: j.id === keep }, j.fileName),
        ),
      );
    }
    comparisons = await FR.api("GET", "/api/comparisons");
    FR.$("#cp-history").replaceChildren(
      ...comparisons
        .slice()
        .reverse()
        .map((c) =>
          FR.el(
            "option",
            { value: c.id },
            `${FR.fmtTime(c.createdAt)} · 차이 ${c.differenceCount}건`,
          ),
        ),
    );
  }
  async function pdfDoc(id) {
    if (!docs[id]) {
      if (!pdfjs) {
        pdfjs = await import("/vendor/pdfjs/build/pdf.min.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc =
          "/vendor/pdfjs/build/pdf.worker.min.mjs";
      }
      docs[id] = pdfjs.getDocument({
        url: `/api/jobs/${id}/file`,
        cMapUrl: "/vendor/pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
        wasmUrl: "/vendor/pdfjs/wasm/",
      }).promise;
    }
    return docs[id];
  }
  async function renderPage(side, anchor, words = []) {
    const seq = ++renderSeq[side],
      id = current[`${side}Id`],
      job = jobs.find((j) => j.id === id),
      view = current[`${side}View`],
      page = Math.max(1, Math.min(anchor?.page || 1, view.pages.length)),
      box = FR.$(`#cp-${side}-pages`),
      surface = FR.el("div", { class: "compare-surface" });
    const picker = FR.el(
      "select",
      {
        "aria-label": `${side === "left" ? "원본" : "비교"} 페이지`,
        onchange: (e) => renderPage(side, { page: Number(e.target.value) }),
      },
      view.pages.map((p) =>
        FR.el(
          "option",
          { value: p.page, selected: p.page === page },
          `${p.page} 페이지`,
        ),
      ),
    );
    box.replaceChildren(picker, surface);
    try {
      if (job?.fileName.toLowerCase().endsWith(".pdf")) {
        const doc = await pdfDoc(id),
          p = await doc.getPage(page),
          base = p.getViewport({ scale: 1 }),
          v = p.getViewport({ scale: 500 / base.width }),
          canvas = document.createElement("canvas");
        canvas.width = v.width;
        canvas.height = v.height;
        await p.render({
          canvas,
          canvasContext: canvas.getContext("2d"),
          viewport: v,
        }).promise;
        if (seq !== renderSeq[side]) return;
        surface.append(canvas);
      } else {
        const img = new Image();
        img.alt = side === "left" ? "원본 문서" : "비교 문서";
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () =>
            reject(new Error("원본 이미지를 불러오지 못했습니다."));
          img.src = `/api/jobs/${id}/image?page=${page}`;
        });
        if (seq !== renderSeq[side]) return;
        surface.append(img);
      }
      const layer = FR.el("div", { class: "compare-overlay" });
      surface.append(layer);
      for (const w of words.filter((w) => w.page === page && w.rect)) {
        const r = w.rect;
        layer.append(
          FR.el("div", {
            class: "compare-highlight",
            style: `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%`,
            title: w.text,
          }),
        );
      }
      if (anchor?.rect && !words.length) {
        const r = anchor.rect;
        layer.append(
          FR.el("div", {
            class: "compare-highlight",
            style: `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%`,
          }),
        );
      }
      requestAnimationFrame(() => {
        const h = layer.firstElementChild;
        if (h) h.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    } catch (e) {
      surface.replaceChildren(
        FR.el("p", { class: "msg ng" }, e.message),
        FR.el("pre", {}, view.pages[page - 1]?.content || ""),
      );
    }
  }
  async function open(c) {
    current = c;
    [c.leftView, c.rightView] = await Promise.all([
      FR.api("GET", `/api/jobs/${c.leftId}/ocr`),
      FR.api("GET", `/api/jobs/${c.rightId}/ocr`),
    ]);
    FR.$("#cp-result").hidden = false;
    FR.$("#cp-count").textContent = `차이점 ${c.differences.length}건`;
    FR.$("#cp-differences").replaceChildren(
      ...c.differences.map((d, i) =>
        FR.el(
          "button",
          {
            class: `difference ${d.type}`,
            onclick: () => {
              FR.$("#cp-differences")
                .querySelectorAll("button")
                .forEach((b) => b.classList.remove("active"));
              FR.$("#cp-differences").children[i].classList.add("active");
              renderPage("left", d.left, d.leftWords || []);
              renderPage("right", d.right, d.rightWords || []);
            },
          },
          `${i + 1}. ${label[d.type]} · ${d.text}`,
        ),
      ),
    );
    if (!c.differences.length)
      FR.$("#cp-differences").textContent = "차이가 없습니다.";
    await Promise.all([
      renderPage("left", { page: 1 }),
      renderPage("right", { page: 1 }),
    ]);
  }
  async function upload(side) {
    const file = FR.$(`#cp-${side}-file`).files[0];
    if (!file) return FR.$(`#cp-${side}`).value;
    const j = await FR.api("POST", "/api/jobs", {
      fileName: file.name,
      contentBase64: await FR.readFileAsBase64(file),
    });
    for (let i = 0; i < 300; i++) {
      const x = await FR.api("GET", `/api/jobs/${j.id}`);
      if (x.status === "done") {
        FR.$(`#cp-${side}-file`).value = "";
        return x.id;
      }
      if (["failed", "cancelled"].includes(x.status))
        throw new Error(x.error || "문서 인식이 취소됐습니다.");
      await FR.sleep(1000);
    }
    throw new Error("인식 중입니다. 전체 문서에서 완료 후 선택하세요.");
  }
  return {
    load,
    init() {
      FR.$("#cp-run").onclick = async () => {
        const b = FR.$("#cp-run");
        b.disabled = true;
        FR.setMsg(FR.$("#cp-msg"), "문서 인식 및 비교 중…");
        try {
          const leftId = await upload("left"),
            rightId = await upload("right"),
            c = await FR.api("POST", "/api/comparisons", {
              leftId,
              rightId,
              compareLayout: FR.$("#cp-layout").checked,
            });
          await load();
          FR.$("#cp-left").value = leftId;
          FR.$("#cp-right").value = rightId;
          await open(c);
          FR.setMsg(
            FR.$("#cp-msg"),
            `비교 완료 · 차이점 ${c.differences.length}건`,
          );
        } catch (e) {
          FR.setMsg(FR.$("#cp-msg"), e.message, false);
        } finally {
          b.disabled = false;
        }
      };
      FR.$("#cp-open").onclick = async () => {
        try {
          const id = FR.$("#cp-history").value;
          if (id) await open(await FR.api("GET", `/api/comparisons/${id}`));
        } catch (e) {
          FR.setMsg(FR.$("#cp-msg"), e.message, false);
        }
      };
    },
  };
})();
