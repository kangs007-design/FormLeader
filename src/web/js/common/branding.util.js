"use strict";
window.FR = window.FR || {};
(() => {
  const defaults = { productName: "DocSquare", companyName: "Digitalsquare", descriptor: "DOCUMENT WORKSPACE", logoUrl: "", faviconUrl: "" };
  const config = window.FR_BRAND || {};
  const brand = Object.fromEntries(Object.entries(defaults).map(([key, value]) =>
    [key, typeof config[key] === "string" && config[key].trim() ? config[key].trim() : value]));
  FR.brand = Object.freeze(brand);
  FR.brandTitle = (page) => `${page} · ${brand.productName}`;
  document.querySelectorAll("[data-brand]").forEach((element) => {
    const value = brand[element.dataset.brand];
    if (value !== undefined) element.textContent = value;
  });
  document.querySelectorAll("[data-brand-login]").forEach((element) =>
    element.setAttribute("aria-label", `${brand.productName} 로그인`));

  // 납품 패키지에 포함한 같은 출처의 이미지로 폐쇄망에서도 동작한다.
  const assetUrl = (value) => {
    if (!value) return "";
    try {
      const url = new URL(value, location.origin);
      return url.origin === location.origin && !url.username && !url.password ? url.href : "";
    } catch (_) { return ""; }
  };
  const logoUrl = assetUrl(brand.logoUrl);
  if (logoUrl) document.querySelectorAll("[data-brand-logo]").forEach((image) => {
    const icon = image.parentElement.querySelector("svg");
    image.addEventListener("load", () => {
      image.hidden = false;
      if (icon) icon.style.display = "none";
    });
    image.addEventListener("error", () => {
      image.hidden = true;
      if (icon) icon.style.display = "";
    });
    image.src = logoUrl;
  });
  const faviconUrl = assetUrl(brand.faviconUrl);
  if (faviconUrl) {
    const link = document.createElement("link");
    link.rel = "icon";
    link.href = faviconUrl;
    document.head.append(link);
  }
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = getComputedStyle(document.documentElement).getPropertyValue("--brand-accent").trim();
})();
