"use strict";
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { PDFDocument, degrees } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
const { PDF_FONT_FEATURES } = require("../../common/pdf-font.util");
const { imagePage } = require("../../common/document.util");
const { AppError } = require("../../common/app.error");

const xml = (v) =>
  String(v ?? "").replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
const md = (v) =>
  String(v ?? "")
    .replace(/\r?\n/g, "<br>")
    .replace(/\|/g, "\\|");
const csv = (v) => {
  const t = String(v ?? "");
  return (
    '"' +
    (/^[\s]*[=+@-]/.test(t) || /^[\t\r\n]/.test(t) ? "'" : "") +
    t.replace(/"/g, '""') +
    '"'
  );
};

class DocumentExportService {
  constructor({ config, formJobService }) {
    this.config = config;
    this.jobs = formJobService;
  }

  async data(id) {
    const job = await this.jobs.get(id);
    if (job.status !== "done")
      throw AppError.badRequest("완료된 문서만 내보낼 수 있습니다.");
    const view = await this.jobs.getOcrView(id);
    return {
      job,
      view,
      fileName: job.fileName,
      values: job.review?.values || job.ocrResult.values || {},
      groups: job.review?.groups || job.ocrResult.groups || {},
      text: job.review?.text ?? view.pages.map((p) => p.content).join("\n\n"),
      review: job.review || null,
    };
  }

  async export(id, format) {
    const d = await this.data(id),
      stem = d.fileName.replace(/\.[^.]+$/, "");
    const result = {
      fileName: d.fileName,
      templateId: d.job.ocrResult.templateId,
      templateVersion: d.job.ocrResult.templateVersion,
      values: d.values,
      groups: d.groups,
      text: d.text,
      pages: d.view.pages,
      review: d.review,
    };
    let bytes, type;
    if (format === "json") {
      bytes = Buffer.from(JSON.stringify(result, null, 2));
      type = "application/json";
    } else if (format === "txt") {
      bytes = Buffer.from(d.text);
      type = "text/plain;charset=utf-8";
    } else if (format === "csv") {
      const rows = [["문서", "그룹", "행", "항목", "값"]];
      Object.entries(d.values).forEach(([k, v]) =>
        rows.push([d.fileName, "", "", k, v.value]),
      );
      Object.entries(d.groups).forEach(([g, data]) =>
        data.rows.forEach((r, i) =>
          Object.entries(r.values).forEach(([k, v]) =>
            rows.push([d.fileName, g, i + 1, k, v.value]),
          ),
        ),
      );
      if (rows.length === 1) rows.push([d.fileName, "", "", "본문", d.text]);
      bytes = Buffer.from(
        "\uFEFF" + rows.map((r) => r.map(csv).join(",")).join("\r\n"),
      );
      type = "text/csv;charset=utf-8";
    } else if (format === "xml") {
      bytes = Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?>\n<document name="' +
          xml(d.fileName) +
          '"><fields>' +
          Object.entries(d.values)
            .map(
              ([k, v]) =>
                `<field name="${xml(k)}" valid="${v.valid}">${xml(v.value)}</field>`,
            )
            .join("") +
          "</fields><groups>" +
          Object.entries(d.groups)
            .map(
              ([g, data]) =>
                `<group name="${xml(g)}">` +
                data.rows
                  .map(
                    (r, i) =>
                      `<row index="${i + 1}" page="${r.page}">` +
                      Object.entries(r.values)
                        .map(
                          ([k, v]) =>
                            `<field name="${xml(k)}">${xml(v.value)}</field>`,
                        )
                        .join("") +
                      "</row>",
                  )
                  .join("") +
                "</group>",
            )
            .join("") +
          "</groups><text>" +
          xml(d.text) +
          "</text></document>",
      );
      type = "application/xml;charset=utf-8";
    } else if (format === "md") {
      let t = `# ${d.fileName.replace(/[\r\n#]/g, " ")}\n\n`;
      if (Object.keys(d.values).length)
        t +=
          "| 항목 | 값 |\n| --- | --- |\n" +
          Object.entries(d.values)
            .map(([k, v]) => `| ${md(k)} | ${md(v.value)} |`)
            .join("\n") +
          "\n\n";
      for (const [name, g] of Object.entries(d.groups))
        t +=
          `## ${name}\n\n| ${g.columns.map(md).join(" | ")} |\n| ${g.columns.map(() => "---").join(" | ")} |\n` +
          g.rows
            .map(
              (r) =>
                "| " +
                g.columns.map((c) => md(r.values[c]?.value)).join(" | ") +
                " |",
            )
            .join("\n") +
          "\n\n";
      for (const p of d.view.pages) {
        t += `## ${p.page} 페이지\n\n${p.content}\n\n`;
        for (const tb of p.tables) {
          if (tb.grid.length)
            t +=
              "| " +
              tb.grid[0].map(md).join(" | ") +
              " |\n| " +
              tb.grid[0].map(() => "---").join(" | ") +
              " |\n" +
              tb.grid
                .slice(1)
                .map((r) => "| " + r.map(md).join(" | ") + " |")
                .join("\n") +
              "\n\n";
        }
      }
      if (d.review?.text !== undefined) t = `# ${d.fileName}\n\n${d.text}`;
      bytes = Buffer.from(t);
      type = "text/markdown;charset=utf-8";
    } else if (format === "xlsx") {
      const w = new ExcelJS.Workbook();
      w.creator = "FormReader";
      const fields = w.addWorksheet("추출 항목");
      fields.addRow(["항목", "값", "검증", "검수"]);
      Object.entries(d.values).forEach(([k, v]) =>
        fields.addRow([
          k,
          String(v.value),
          v.valid ? "정상" : v.errors.join(", "),
          d.review?.confirmed ? "완료" : "미확정",
        ]),
      );
      for (const [name, g] of Object.entries(d.groups)) {
        const s = w.addWorksheet(
          `반복${w.worksheets.length}_${name.replace(/[\\/?*\[\]:]/g, "").slice(0, 18)}`,
        );
        s.addRow(["페이지", ...g.columns]);
        g.rows.forEach((r) =>
          s.addRow([
            r.page,
            ...g.columns.map((c) => String(r.values[c]?.value || "")),
          ]),
        );
      }
      const p = w.addWorksheet("본문");
      p.addRow(["페이지", "본문"]);
      if (d.review?.text !== undefined) p.addRow(["검수 본문", d.text]);
      else d.view.pages.forEach((page) => p.addRow([page.page, page.content]));
      for (const page of d.view.pages)
        for (const [i, t] of page.tables.entries()) {
          const s = w.addWorksheet(`표_${page.page}_${i + 1}`);
          t.grid.forEach((r) => s.addRow(r.map(String)));
        }
      for (const s of w.worksheets) {
        s.views = [{ state: "frozen", ySplit: 1 }];
        s.getRow(1).font = { bold: true };
        s.columns.forEach((c, i) => {
          c.width = i === 0 ? 26 : 46;
        });
        s.eachRow((r) => {
          r.alignment = { vertical: "top", wrapText: true };
        });
      }
      bytes = Buffer.from(await w.xlsx.writeBuffer());
      type =
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    } else if (format === "pdf") {
      bytes = await this.searchablePdf(d);
      type = "application/pdf";
    } else
      throw AppError.badRequest(
        "지원하는 형식: json, xml, txt, csv, xlsx, pdf, md",
      );
    return { bytes, type, name: `${stem}.${format}` };
  }

  async searchablePdf(d) {
    const file = path.join(this.config.storage.inputDir, d.job.storedName);
    let pdf;
    if (path.extname(file).toLowerCase() === ".pdf")
      pdf = await PDFDocument.load(fs.readFileSync(file));
    else {
      pdf = await PDFDocument.create();
      for (let i = 0; i < d.view.pages.length; i++) {
        const image = await pdf.embedPng(await imagePage(file, i + 1));
        const p = pdf.addPage([image.width, image.height]);
        p.drawImage(image, {
          x: 0,
          y: 0,
          width: image.width,
          height: image.height,
        });
      }
    }
    pdf.registerFontkit(fontkit);
    const fontPath = path.join(
      this.config.webDir,
      "vendor",
      "fonts",
      "Pretendard-Regular.ttf",
    );
    // Fontkit's subset writer loses composite glyphs for this Korean font. Embed the complete static font.
    const font = await pdf.embedFont(fs.readFileSync(fontPath), {
      subset: false,
      features: { ...PDF_FONT_FEATURES },
    });
    for (let i = 0; i < d.view.pages.length; i++) {
      const p = pdf.getPage(i),
        b = p.getCropBox(),
        angle = ((p.getRotation().angle % 360) + 360) % 360,
        o = d.view.pages[i];
      const W = angle % 180 ? b.height : b.width,
        H = angle % 180 ? b.width : b.height;
      for (const word of o.words) {
        const text = word.text.replace(/[\r\n\t]/g, " ");
        if (!text) continue;
        const u = (word.x1 / o.width) * W,
          v = (word.y2 / o.height) * H;
        const pos =
          angle === 90
            ? { x: b.x + v, y: b.y + u }
            : angle === 180
              ? { x: b.x + b.width - u, y: b.y + v }
              : angle === 270
                ? { x: b.x + b.width - v, y: b.y + b.height - u }
                : { x: b.x + u, y: b.y + b.height - v };
        const h = Math.max(1, ((word.y2 - word.y1) / o.height) * H),
          width = Math.max(1, ((word.x2 - word.x1) / o.width) * W);
        const size = Math.max(
          0.5,
          Math.min(
            h * 0.9,
            width / Math.max(0.01, font.widthOfTextAtSize(text, 1)),
          ),
        );
        p.drawText(text, {
          ...pos,
          font,
          size,
          opacity: 0,
          rotate: degrees(angle),
        });
      }
    }
    await pdf.attach(
      Buffer.from(
        JSON.stringify(
          { values: d.values, groups: d.groups, review: d.review },
          null,
          2,
        ),
      ),
      "formreader-result.json",
      { mimeType: "application/json", description: "검수 및 서식 추출 결과" },
    );
    return Buffer.from(await pdf.save());
  }
}
module.exports = { DocumentExportService };
