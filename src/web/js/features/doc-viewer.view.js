"use strict";
/**
 * 웹 개별기능[doc-viewer]: 문서 확인 화면의 왼쪽 문서 뷰어
 *  - 원본 모드: 업로드한 원본(PDF 는 pdf.js 로 렌더링, 이미지는 <img>)을 그대로 표시 + (선택) 인식 영역 오버레이
 *  - 텍스트 모드: 인식된 단어를 위치대로 재배치한 보기 (원본을 표시할 수 없을 때의 대체 화면)
 */
FR.docViewer = (() => {
  const PDF_BASE = "/vendor/pdfjs";
  // TextSense 가 PDF 를 이미지로 변환하는 배율 (72dpi 대비). 실측으로 2배였고, 인식 좌표가 이를 넘으면 자동 보정한다.
  const PDF_OCR_SCALE = 2;
  const IMG_EXT = [".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"];

  const state = {
    jobId: null,
    ext: "",
    view: null,
    idx: 0,
    zoom: 1,
    rotation: 0,
    mode: "original",
    overlay: false,
    originalOk: true,
    pdfPromise: null,
    token: 0,
    geom: null,
    note: "",
    stageWidth: 0,
  };
  let pdfjsPromise = null;
  let resizeTimer = null;

  const page = () => state.view.pages[state.idx];
  const low = (w) => w.conf !== null && w.conf < 0.6;

  /* ---------- pdf.js 로드/문서 열기 ---------- */
  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(`${PDF_BASE}/build/pdf.min.mjs`).then((m) => {
        m.GlobalWorkerOptions.workerSrc = `${PDF_BASE}/build/pdf.worker.min.mjs`;
        return m;
      });
      pdfjsPromise.catch(() => {
        pdfjsPromise = null;
      }); // 실패 시 다음에 다시 시도
    }
    return pdfjsPromise;
  }

  function getPdf() {
    if (!state.pdfPromise) {
      state.pdfPromise = loadPdfjs().then(
        (pdfjs) =>
          pdfjs.getDocument({
            url: `/api/jobs/${encodeURIComponent(state.jobId)}/file`,
            cMapUrl: `${PDF_BASE}/cmaps/`,
            cMapPacked: true, // 한글 등 CJK 비임베디드 글꼴용
            standardFontDataUrl: `${PDF_BASE}/standard_fonts/`,
            wasmUrl: `${PDF_BASE}/wasm/`,
            iccUrl: `${PDF_BASE}/iccs/`, // 스캔 PDF(JBIG2/JPX) 이미지 디코더
          }).promise,
      );
      state.pdfPromise.catch(() => {
        state.pdfPromise = null;
      });
    }
    return state.pdfPromise;
  }

  function closePdf() {
    const old = state.pdfPromise;
    state.pdfPromise = null;
    if (old) old.then((doc) => doc.destroy()).catch(() => {});
  }

  /* ---------- 공통: 툴바 상태 ---------- */
  function syncToolbar() {
    const total = state.view.pages.length;
    FR.$("#or-page-label").textContent = `${state.idx + 1} / ${total}`;
    FR.$("#or-zoom-label").textContent = `${Math.round(state.zoom * 100)}%`;
    FR.$("#or-prev").disabled = state.idx === 0;
    FR.$("#or-next").disabled = state.idx >= total - 1;
    const orig = FR.$("#or-mode-original");
    const text = FR.$("#or-mode-text");
    orig.setAttribute("aria-pressed", String(state.mode === "original"));
    text.setAttribute("aria-pressed", String(state.mode === "text"));
    orig.disabled = !state.originalOk;
    orig.title = state.originalOk
      ? "업로드한 원본 문서 그대로 표시"
      : "이 문서는 원본을 표시할 수 없습니다";
    const ov = FR.$("#or-overlay-toggle");
    ov.hidden = state.mode !== "original";
    ov.setAttribute("aria-pressed", String(state.overlay));
    FR.$("#or-sheet-note").textContent = state.note;
  }

  /* ---------- 원본 모드 ---------- */
  function renderOverlay() {
    const layer = FR.$("#or-overlay-layer");
    if (!layer) return;
    layer.replaceChildren();
    layer.hidden = !state.overlay;
    if (!state.overlay || !state.geom) return;
    const { ocrW, ocrH } = state.geom;
    layer.append(
      ...page().words.map((w) =>
        FR.el("div", {
          class: `ov-box${low(w) ? " low" : ""}`,
          title: `${w.text}${w.conf !== null ? ` (신뢰도 ${w.conf.toFixed(2)})` : ""}`,
          style: `left:${(w.x1 / ocrW) * 100}%;top:${(w.y1 / ocrH) * 100}%;width:${((w.x2 - w.x1) / ocrW) * 100}%;height:${((w.y2 - w.y1) / ocrH) * 100}%`,
        }),
      ),
    );
  }

  function fallbackToText(reason) {
    state.originalOk = false;
    state.mode = "text";
    state.note = `원본을 표시할 수 없어 인식 텍스트로 보여줍니다. (${reason})`;
    render();
  }

  async function renderOriginal() {
    const my = ++state.token;
    const sheet = FR.$("#or-sheet");
    const p = page();
    sheet.className = "sheet original";
    sheet.style.aspectRatio = "";
    sheet.style.width = "";
    sheet.replaceChildren(
      FR.el("div", { class: "sheet-loading" }, "원본 문서를 불러오는 중..."),
    );

    const stage = FR.$(".sheet-stage");
    state.stageWidth = stage.clientWidth;
    const cssWidth = Math.max(240, (stage.clientWidth - 40) * state.zoom);
    const surface = FR.el("div", { class: "doc-surface" });
    try {
      let ocrW;
      let ocrH;
      if (state.ext === ".pdf") {
        const pdf = await getPdf();
        if (my !== state.token) return;
        if (state.idx + 1 > pdf.numPages)
          throw new Error("원본 PDF 에 해당 페이지가 없습니다");
        const pdfPage = await pdf.getPage(state.idx + 1);
        if (my !== state.token) return;

        const base = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({ scale: cssWidth / base.width });
        const dpr = Math.min(window.devicePixelRatio || 1, 2); // 선명하게 (고해상도 화면)
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        await pdfPage.render({
          canvas,
          canvasContext: canvas.getContext("2d"),
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        }).promise;
        if (my !== state.token) return;
        surface.append(canvas);

        // 인식 좌표(이미지 픽셀) → 페이지 비율: PDF 크기(pt) × 변환 배율. 인식 범위가 이를 넘으면 배율을 키워 보정
        const s = Math.max(
          PDF_OCR_SCALE,
          p.width / base.width,
          p.height / base.height,
        );
        ocrW = p.sizeSource !== "estimated" ? p.width : base.width * s;
        ocrH = p.sizeSource !== "estimated" ? p.height : base.height * s;
      } else {
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(new Error("이미지를 불러올 수 없습니다"));
          img.src = `/api/jobs/${encodeURIComponent(state.jobId)}/image?page=${state.idx + 1}`;
        });
        if (my !== state.token) return;
        img.alt = "원본 문서";
        img.style.width = `${cssWidth}px`;
        surface.append(img);
        ocrW = img.naturalWidth;
        ocrH = img.naturalHeight;
      }
      state.geom = { ocrW, ocrH };
      surface.append(
        FR.el("div", { class: "overlay", id: "or-overlay-layer" }),
      );
      sheet.replaceChildren(surface);
      renderOverlay();
      if (state.rotation) {
        const w = surface.offsetWidth,
          h = surface.offsetHeight,
          angle = state.rotation,
          wrap = FR.el("div", {
            style: `position:relative;width:${angle % 180 ? h : w}px;height:${angle % 180 ? w : h}px;flex:none`,
          });
        surface.style.position = "absolute";
        surface.style.transformOrigin = "0 0";
        surface.style.transform =
          angle === 90
            ? `translate(${h}px,0) rotate(90deg)`
            : angle === 180
              ? `translate(${w}px,${h}px) rotate(180deg)`
              : `translate(0,${w}px) rotate(270deg)`;
        surface.replaceWith(wrap);
        wrap.append(surface);
      }
    } catch (e) {
      if (my !== state.token) return;
      console.error("원본 표시 실패", e);
      fallbackToText(e.message || "알 수 없는 오류");
    }
  }

  /* ---------- 텍스트 모드: 인식된 단어를 페이지 위치 그대로 재현 ---------- */
  /** 크기를 모르는(추정) 페이지는 단어가 가장자리에 붙지 않도록 여백을 둔다. */
  function sheetBox(p) {
    const pad =
      p.sizeSource === "image"
        ? 0
        : Math.round(Math.max(p.width, p.height) * 0.06);
    return { pad, W: p.width + pad * 2, H: p.height + pad * 2 };
  }

  function layoutWords() {
    if (state.mode !== "text" || !state.view) return;
    const sheet = FR.$("#or-sheet");
    if (!sheet.clientWidth) return;
    const scale = sheet.clientWidth / sheetBox(page()).W;
    sheet.querySelectorAll(".sheet-word").forEach((el) => {
      el.style.fontSize = `${Math.max(6, Number(el.dataset.h) * scale * 0.82)}px`;
    });
  }

  function renderText() {
    state.token += 1; // 진행 중인 원본 렌더링 취소
    const sheet = FR.$("#or-sheet");
    const p = page();
    const { pad, W, H } = sheetBox(p);
    sheet.className = "sheet text";
    sheet.style.aspectRatio = `${W} / ${H}`;
    sheet.style.width = `${state.zoom * 100}%`;
    sheet.replaceChildren(
      ...p.words.map((w) =>
        FR.el(
          "span",
          {
            class: `sheet-word${low(w) ? " low" : ""}`,
            title: `${w.text}${w.conf !== null ? ` (신뢰도 ${w.conf.toFixed(2)})` : ""}`,
            "data-h": w.y2 - w.y1,
            style: `left:${((w.x1 + pad) / W) * 100}%;top:${((w.y1 + pad) / H) * 100}%;width:${((w.x2 - w.x1) / W) * 100}%;height:${((w.y2 - w.y1) / H) * 100}%`,
          },
          w.text,
        ),
      ),
    );
    if (!state.note && p.sizeSource !== "image")
      state.note = "※ 인식된 텍스트를 위치대로 재현한 화면입니다.";
    layoutWords();
  }

  function render() {
    if (!state.view) return;
    if (state.mode === "original") state.note = "";
    syncToolbar();
    if (state.mode === "original") renderOriginal();
    else {
      renderText();
      syncToolbar();
    }
  }

  /* ---------- 외부 API ---------- */
  return {
    /** 결과 화면을 열 때 1회 호출 (작업/원본 정보 설정) */
    open({ jobId, fileName, view }) {
      closePdf();
      const ext = (/\.[^.]+$/.exec(fileName) || [""])[0].toLowerCase();
      Object.assign(state, {
        jobId,
        ext,
        view,
        idx: 0,
        zoom: 1,
        rotation: 0,
        overlay: false,
        geom: null,
        note: "",
        originalOk: ext === ".pdf" || IMG_EXT.includes(ext),
      });
      state.mode = state.originalOk ? "original" : "text";
      if (!state.originalOk)
        state.note =
          "이 형식은 브라우저에서 원본을 표시할 수 없어 인식 텍스트로 보여줍니다.";
    },
    /** 페이지 표시 */
    show(idx) {
      state.idx = idx;
      render();
    },
    init() {
      const zoom = (delta) => {
        state.zoom = Math.min(
          3,
          Math.max(0.5, Math.round((state.zoom + delta) * 100) / 100),
        );
        render();
      };
      FR.$("#or-zoom-in").addEventListener("click", () => zoom(0.25));
      FR.$("#or-zoom-out").addEventListener("click", () => zoom(-0.25));
      FR.$("#or-rotate").addEventListener("click", () => {
        state.rotation = (state.rotation + 90) % 360;
        state.mode = "original";
        render();
      });
      FR.$("#or-mode-original").addEventListener("click", () => {
        if (state.originalOk) {
          state.mode = "original";
          render();
        }
      });
      FR.$("#or-mode-text").addEventListener("click", () => {
        state.mode = "text";
        state.note = "";
        render();
      });
      FR.$("#or-overlay-toggle").addEventListener("click", () => {
        state.overlay = !state.overlay;
        syncToolbar();
        renderOverlay();
      });

      if (window.ResizeObserver) {
        // 창/레이아웃 폭이 바뀌면 다시 맞춘다
        new ResizeObserver(() => {
          if (
            !state.view ||
            !FR.$("#tab-ocr-result").classList.contains("active")
          )
            return;
          if (state.mode === "text") {
            layoutWords();
            return;
          }
          if (Math.abs(FR.$(".sheet-stage").clientWidth - state.stageWidth) < 3)
            return;
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(render, 150);
        }).observe(FR.$(".sheet-stage"));
      }
    },
  };
})();
