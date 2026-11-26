"use strict";
/** 웹 진입점: 사이드바 탭 전환 + 검색 + 각 화면 초기화 */
const TAB_LOADERS = {
  dashboard: () => FR.productCapabilities?.ocrProcessing === false ? undefined : FR.dashboardView.load(),
  "job-request": () => FR.formJobView.loadTemplateOptions(),
  "job-status": () => FR.formJobView.refresh(),
  "form-template": () => FR.formTemplateView.load(),
  "ocr-connect": () => FR.ocrConnectView.load(),
  users: () => FR.usersView.load(),
  compare: () => FR.compareView.load(),
  operations: () => FR.operationsView.load(),
};
const TAB_NAMES = {
  dashboard: "워크스페이스",
  "job-request": "문서 업로드",
  "job-status": "전체 문서",
  "form-template": "서식 라이브러리",
  "ocr-result": "문서 검수",
  "ocr-connect": "연결 설정",
  users: "사용자 관리",
  compare: "문서 비교",
  operations: "운영 관리",
};

FR.showTab = function showTab(name) {
  if (!TAB_NAMES[name]) name = "dashboard";
  if (FR.productCapabilities && name !== 'dashboard' && !FR.productCapabilities.tabs.includes(name)) name = 'dashboard';
  if (
    ["users", "form-template", "ocr-connect", "operations"].includes(name) &&
    FR.currentUser?.role !== "admin"
  )
    name = "dashboard";
  document.querySelectorAll("#tabs .nav-item").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
    if (b.dataset.tab === name) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  document
    .querySelectorAll(".tab")
    .forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
  FR.$("#current-page").textContent = TAB_NAMES[name];
  document.title = FR.brandTitle(TAB_NAMES[name]);
  FR.mobileNav?.closeForNavigation();
  history.replaceState(null, "", `#${name}`);
  window.scrollTo({ top: 0 });
  if (TAB_LOADERS[name])
    Promise.resolve(TAB_LOADERS[name]()).catch((e) => console.error(e));
};

/** 현재 보이는 화면의 목록을 다시 불러온다 (삭제/검색 후) */
FR.refreshActive = function refreshActive() {
  const active = document.querySelector(".tab.active");
  const name = active && active.id.replace(/^tab-/, "");
  if (name === "dashboard" || name === "job-status") TAB_LOADERS[name]();
};

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await FR.accountView.init();
  } catch (_) {
    return;
  }
  FR.ocrConnectView.init();
  FR.formTemplateView.init();
  FR.formJobView.init();
  FR.dashboardView.init();
  FR.usersView.init();
  FR.operationsView.init();
  FR.compareView.init();
  if (FR.productCapabilities?.ocrProcessing === false) {
    document.querySelectorAll('#tabs [data-tab]').forEach((button) => {
      if (button.dataset.tab !== 'dashboard' && !FR.productCapabilities.tabs.includes(button.dataset.tab)) {
        button.disabled = true;
        button.title = '제품판 준비 중';
      }
    });
    FR.$('#js-search').disabled = true;
    FR.$('#js-search').placeholder = '문서 기능 준비 중';
    const title = document.createElement('h1');
    title.textContent = '제품판 준비 중';
    const description = document.createElement('p');
    description.className = 'sub';
    description.textContent = '현재 계정 관리와 서식 저장을 이용할 수 있습니다. 문서 인식·검수·내보내기는 Pilot v1에서 계속 이용해 주세요.';
    const card = document.createElement('div');
    card.className = 'card';
    card.append(title, description);
    FR.$('#tab-dashboard').replaceChildren(card);
    // Samples and test OCR move together with the document-processing APIs.
    document.querySelectorAll('#ft-sample, #ft-preview').forEach((element) => {
      element.disabled = true;
      element.title = '샘플 인식은 제품판 준비 중입니다.';
    });
  } else FR.syncJobCount().catch(() => {});
  FR.$("#today-label").textContent = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date());
  const help = FR.$("#help-dialog");
  const openHelp = () => {
    FR.mobileNav?.closeForNavigation();
    help.showModal();
  };
  FR.$("#help-open").addEventListener("click", openHelp);
  FR.$("#help-close").addEventListener("click", () => help.close());
  help.addEventListener("click", (e) => {
    if (e.target === help) {
      const rect = help.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      )
        help.close();
    }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      FR.showTab("job-status");
      FR.$("#js-search").focus();
    }
    if (
      e.key === "?" &&
      !["INPUT", "TEXTAREA", "SELECT"].includes(
        document.activeElement.tagName,
      ) &&
      !help.open
    )
      openHelp();
  });

  initNavGroups();
  FR.mobileNav = FR.initMobileNav();
  document
    .querySelectorAll("#tabs .nav-item")
    .forEach((b) =>
      b.addEventListener("click", () => FR.showTab(b.dataset.tab)),
    );
  document
    .querySelectorAll("[data-goto]")
    .forEach((b) =>
      b.addEventListener("click", () => FR.showTab(b.dataset.goto)),
    );

  const initial = location.hash.slice(1);
  FR.showTab(initial === "ocr-result" ? "job-status" : initial || "dashboard");
  FR.$("#workspace-app").hidden = false;
});

/** 사이드바 메뉴 그룹(WORKSPACE / MANAGE) 접기·펼치기. 상태는 브라우저에 기억한다 */
function initNavGroups() {
  const KEY = "fr.navCollapsed";
  let collapsed = [];
  try { collapsed = JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (_) { /* 저장소 사용 불가 */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(collapsed)); } catch (_) { /* 무시 */ } };
  document.querySelectorAll(".nav-group").forEach((group) => {
    const name = group.dataset.group;
    const toggle = group.querySelector(".nav-group-toggle");
    const set = (isCollapsed) => {
      group.classList.toggle("collapsed", isCollapsed);
      toggle.setAttribute("aria-expanded", String(!isCollapsed));
    };
    set(collapsed.includes(name));
    toggle.addEventListener("click", () => {
      const next = !group.classList.contains("collapsed");
      set(next);
      collapsed = next ? [...new Set([...collapsed, name])] : collapsed.filter((n) => n !== name);
      save();
    });
  });
}
