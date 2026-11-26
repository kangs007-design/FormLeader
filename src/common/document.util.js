"use strict";
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { PDFDocument } = require("pdf-lib");
const { getImageSize } = require("./image-size.util");
const { AppError } = require("./app.error");

async function documentGeometry(file, pdfScale = 2) {
  const bytes = fs.readFileSync(file);
  if (path.extname(file).toLowerCase() === ".pdf") {
    try {
      const pdf = await PDFDocument.load(bytes);
      return pdf.getPages().map((p) => {
        const b = p.getCropBox(),
          rotation = ((p.getRotation().angle % 360) + 360) % 360;
        const swapped = rotation === 90 || rotation === 270;
        return {
          width: (swapped ? b.height : b.width) * pdfScale,
          height: (swapped ? b.width : b.height) * pdfScale,
          pdfScale,
          rotation,
          source: "pdf",
        };
      });
    } catch (_) {
      return [];
    }
  }
  try {
    const m = await sharp(bytes).metadata();
    return Array.from({ length: m.pages || 1 }, () => ({
      width: m.width,
      height: m.pageHeight || m.height,
      source: "image",
    }));
  } catch (_) {
    const s = getImageSize(bytes);
    return s ? [s] : [];
  }
}

async function imagePage(file, page = 1) {
  const n = Number(page);
  if (!Number.isInteger(n) || n < 1 || n > 10000)
    throw AppError.badRequest("페이지 번호가 올바르지 않습니다.");
  const m = await sharp(file).metadata();
  if (n > (m.pages || 1)) throw AppError.badRequest("해당 이미지 페이지가 없습니다.");
  return sharp(file, { page: n - 1, pages: 1 })
    .png()
    .toBuffer();
}

async function copyDocumentPages(file, numbers) {
  if (path.extname(file).toLowerCase() === ".pdf") {
    const src = await PDFDocument.load(fs.readFileSync(file));
    if (numbers.some((n) => n < 1 || n > src.getPageCount()))
      throw AppError.badRequest("원본에 없는 페이지입니다.");
    const out = await PDFDocument.create();
    (
      await out.copyPages(
        src,
        numbers.map((n) => n - 1),
      )
    ).forEach((p) => out.addPage(p));
    return Buffer.from(await out.save());
  }
  const out = await PDFDocument.create();
  for (const n of numbers) {
    const png = await out.embedPng(await imagePage(file, n));
    const p = out.addPage([png.width, png.height]);
    p.drawImage(png, { x: 0, y: 0, width: png.width, height: png.height });
  }
  return Buffer.from(await out.save());
}

module.exports = { documentGeometry, imagePage, copyDocumentPages };
