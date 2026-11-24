"use strict";
/** 모바일에서는 사이드바를 모달 메뉴로 사용하고 데스크톱에서는 기존 고정 메뉴를 유지한다. */
FR.initMobileNav = function initMobileNav() {
  const media = matchMedia("(max-width: 900px)");
  const sidebar = document.querySelector("#app-sidebar");
  const main = document.querySelector(".main");
  const toggle = document.querySelector("#mobile-menu-toggle");
  const closeButton = document.querySelector("#mobile-menu-close");
  const backdrop = document.querySelector("#mobile-nav-backdrop");
  let open = false;

  function setOpen(next, restoreFocus = true) {
    const wasOpen = open;
    open = media.matches && next;
    document.body.classList.toggle("mobile-nav-open", open);
    sidebar.classList.toggle("mobile-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    backdrop.hidden = !open;
    main.inert = open;
    sidebar.inert = media.matches && !open;
    if (media.matches) sidebar.setAttribute("aria-hidden", String(!open));
    else sidebar.removeAttribute("aria-hidden");
    if (open) {
      sidebar.setAttribute("role", "dialog");
      sidebar.setAttribute("aria-modal", "true");
      closeButton.focus();
    } else {
      sidebar.removeAttribute("role");
      sidebar.removeAttribute("aria-modal");
      if (wasOpen && restoreFocus && media.matches) toggle.focus();
    }
  }
  toggle.addEventListener("click", () => setOpen(!open));
  closeButton.addEventListener("click", () => setOpen(false));
  backdrop.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (event) => {
    if (!open) return;
    if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
    if (event.key !== "Tab") return;
    const focusable = [...sidebar.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex="0"]')]
      .filter((element) => element.getClientRects().length && !element.closest("[hidden]"));
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  media.addEventListener("change", () => {
    const hadSidebarFocus = sidebar.contains(document.activeElement);
    setOpen(false);
    if (media.matches && hadSidebarFocus) toggle.focus();
  });
  setOpen(false);
  return {
    closeForNavigation() {
      if (!open) return;
      setOpen(false, false);
      document.querySelector("#main-content").focus({ preventScroll: true });
    },
  };
};
