'use strict';
/** 개별기능[form-template]: 서식 등록/조회/수정/삭제 */
const path = require('path');
const { JsonFileRepository } = require('../../common/json-file.repository');
const { createId } = require('../../common/id.util');
const { AppError } = require('../../common/app.error');
const { normalizeTemplateInput } = require('./form-template.validator');

class FormTemplateService {
  constructor({ config }) {
    this.repo = new JsonFileRepository(path.join(config.dataDir, 'form-templates.json'));
  }

  list() { return this.repo.list(); }

  async get(id) {
    const item = await this.repo.get(id);
    if (!item) throw AppError.notFound(`서식을 찾을 수 없습니다: ${id}`);
    return item;
  }

  async create(input) {
    const data = normalizeTemplateInput(input);
    const now = new Date().toISOString();
    return this.repo.insert({ id: createId('form'), ...data, createdAt: now, updatedAt: now });
  }

  async update(id, input) {
    await this.get(id);
    const data = normalizeTemplateInput(input);
    return this.repo.update(id, { ...data, updatedAt: new Date().toISOString() });
  }

  async remove(id) {
    await this.get(id);
    await this.repo.remove(id);
    return { id };
  }
}

module.exports = { FormTemplateService };
