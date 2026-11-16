"use strict";
// Contextual/standard ligatures can produce glyph IDs missing from pdf-lib's full-font ToUnicode map.
// OCR layers must preserve the exact source characters for search and copy/paste.
const PDF_FONT_FEATURES = { calt: false, liga: false, clig: false };
module.exports = { PDF_FONT_FEATURES };
