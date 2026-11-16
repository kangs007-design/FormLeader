'use strict';
/** 개별기능[ocr-result]: OCR 결과 JSON 을 화면용 추출값으로 변환하고, 서식 정책을 적용한다 */
const { normalizeOcr, buildView, summarize, extractByTemplate, classifyTemplate } = require('./ocr-result.extractor');

class OcrResultService {
  constructor({ formTemplateService }) {
    this.formTemplateService = formTemplateService;
  }

  /** 페이지별 추출 결과(텍스트/단어/표/SearchAPI fields) - 결과 화면용 */
  view(ocrRaw, opts) {
    return buildView(normalizeOcr(ocrRaw, opts));
  }

  /**
   * @param ocrRaw TextSense 결과 JSON
   * @param templateId 지정 시 해당 서식 적용, 없으면 키워드로 자동 분류
   * @param opts.pageSize 알고 있는 페이지 픽셀 크기
   * @returns { classified, templateId, docType, values, needsReview, pageCount, wordCount, ... }
   */
  async apply(ocrRaw, templateId, opts) {
    const ocr = normalizeOcr(ocrRaw, opts);
    const summary = summarize(ocr);
    const template = templateId
      ? await this.formTemplateService.get(templateId)
      : classifyTemplate(await this.formTemplateService.list(), ocr);

    if (!template) { // 미분류: OCR 추출값만 제공 (서식 미적용)
      return { ...summary, classified: false, templateId: null, docType: null, values: {}, needsReview: true };
    }
    const { values, needsReview } = extractByTemplate(template, ocr);
    return { ...summary, classified: true, templateId: template.id, docType: template.docType, values, needsReview };
  }
}

module.exports = { OcrResultService };
