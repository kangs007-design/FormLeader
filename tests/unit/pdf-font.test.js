"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  path = require("path");
const { PDF_FONT_FEATURES } = require("../../src/common/pdf-font.util");
test("검색 PDF의 하이픈·한글·영문은 ToUnicode에 있는 글리프로 인코딩된다", () => {
  const f = require("@pdf-lib/fontkit").create(
    fs.readFileSync(
      path.resolve(
        __dirname,
        "../../src/web/vendor/fonts/Pretendard-Regular.ttf",
      ),
    ),
  );
  const ids = new Set(f.characterSet.map((cp) => f.glyphForCodePoint(cp).id));
  const text = "청구서 A-2025-001 office 1,234,000 10%";
  for (const g of f.layout(text, { ...PDF_FONT_FEATURES }).glyphs)
    assert.ok(ids.has(g.id), `검색 매핑이 없는 글리프: ${g.id}`);
  const hyphens = f
    .layout("A-2025-001", { ...PDF_FONT_FEATURES })
    .glyphs.filter((g) => g.codePoints.includes(45));
  assert.equal(hyphens.length, 2);
  assert.ok(hyphens.every((g) => g.id === f.glyphForCodePoint(45).id));
});
