"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  normalizeOcr,
  extractByTemplate,
  selectValue,
} = require("../../src/features/ocr-result/ocr-result.extractor");
const {
  mergeOptions,
} = require("../../src/features/ocr-connect/engine-policy.util");
test("실서버 SearchAPI의 keys/values 객체와 배열 형식을 모두 정규화한다", () => {
  const word = {
    type: "word",
    points: [
      [10, 20],
      [30, 40],
    ],
    recognition: { content: "A-2025-001", confidence: [0.9] },
  };
  const o = normalizeOcr(
    {
      document: {
        pages: {
          pages_1: {
            elements: [word],
            fields: { actual: { keys: [], values: [word] }, legacy: [word] },
          },
        },
      },
    },
    { pageSize: { width: 100, height: 100 } },
  );
  assert.equal(o.pages[0].fields[0].text, "A-2025-001");
  assert.equal(o.pages[0].fields[1].text, "A-2025-001");
  assert.equal(
    extractByTemplate(
      {
        keys: [
          {
            name: "actual",
            searchType: "FindRegion",
            rect: { x: 0, y: 0, w: 1, h: 1 },
          },
        ],
      },
      o,
    ).values.actual.value,
    "A-2025-001",
  );
});

test("완료 문서의 SearchAPI 재적용은 캐시된 fields 없이 행·열·단어를 탐색한다", () => {
  const { createSampleOcr } = require("../mock/mock-textsense.server");
  const p = normalizeOcr(createSampleOcr(), {
    pageSize: { width: 1000, height: 1400 },
  }).pages[0];
  const base = { rect: { x: 0, y: 0, w: 1, h: 1 } };
  assert.equal(
    selectValue({ ...base, searchType: "FindRightRow", searchKey: "품목" }, p),
    "금액",
  );
  assert.equal(
    selectValue({ ...base, searchType: "FindBottomCol", searchKey: "금액" }, p),
    "1,234,000",
  );
  assert.match(
    selectValue({ ...base, searchType: "FindLine", searchKey: "문서번호" }, p),
    /A-2025-001/,
  );
});
test("정책 병합은 기존 중첩 설정을 보존하고 잘못된 요청을 거절한다", () => {
  assert.deepEqual(
    mergeOptions(
      { CustomSetting: { TextScoreThreshold: 0.5, TextInputMaxAxis: 2200 } },
      { CustomSetting: { TextScoreThreshold: 0.7 } },
    ),
    { CustomSetting: { TextScoreThreshold: 0.7, TextInputMaxAxis: 2200 } },
  );
  assert.throws(() => mergeOptions({}, { SearchAPI: "invalid" }));
  assert.throws(() =>
    mergeOptions(
      {},
      {
        SearchAPI: [
          {
            Type: "FindRegion",
            Name: "x",
            Key: [
              [0, "bad"],
              [1, 2],
            ],
          },
        ],
      },
    ),
  );
  assert.throws(() =>
    mergeOptions({}, JSON.parse('{"__proto__":{"polluted":true}}')),
  );
});
