"use strict";
const { AppError } = require("../../common/app.error");
const TYPES = [
  "FindRegion",
  "FindLine",
  "FindWord",
  "FindRow",
  "FindRightRow",
  "FindCol",
  "FindBottomCol",
];
function validateOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw AppError.badRequest("엔진 요청 옵션은 JSON 객체여야 합니다.");
  if (options.SearchAPI !== undefined) {
    if (!Array.isArray(options.SearchAPI) || options.SearchAPI.length > 500)
      throw AppError.badRequest("SearchAPI는 500개 이내의 배열이어야 합니다.");
    for (const r of options.SearchAPI) {
      if (
        !r ||
        !TYPES.includes(r.Type) ||
        typeof r.Name !== "string" ||
        !r.Name.trim() ||
        !Array.isArray(r.Key)
      )
        throw AppError.badRequest("SearchAPI의 Type, Name, Key를 확인하세요.");
      if (
        r.Type === "FindRegion"
          ? r.Key.length !== 2 ||
            r.Key.some(
              (p) =>
                !Array.isArray(p) ||
                p.length !== 2 ||
                p.some((n) => typeof n !== "number" || !Number.isFinite(n)),
            )
          : !r.Key.length ||
            r.Key.some((k) => typeof k !== "string" || !k.trim())
      )
        throw AppError.badRequest(
          "SearchAPI 탐색 키 또는 영역 좌표가 올바르지 않습니다.",
        );
    }
  }
  for (const [key, value] of Object.entries(options)) {
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw AppError.badRequest("허용하지 않는 옵션 키입니다.");
    if (value && typeof value === "object" && !Array.isArray(value))
      validateOptions(value);
  }
  return options;
}
function mergeOptions(base = {}, extra = {}) {
  validateOptions(base);
  validateOptions(extra);
  const result = { ...base };
  for (const [key, value] of Object.entries(extra))
    result[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? mergeOptions(
            base[key] &&
              typeof base[key] === "object" &&
              !Array.isArray(base[key])
              ? base[key]
              : {},
            value,
          )
        : value;
  return result;
}
module.exports = { validateOptions, mergeOptions };
