"use strict";
/** 개별기능[form-template]: 서식 등록/조회/수정/삭제 */
const path = require("path");
const { SqliteRepository } = require("../../common/sqlite.repository");
const { createId } = require("../../common/id.util");
const { AppError } = require("../../common/app.error");
const { normalizeTemplateInput } = require("./form-template.validator");

class FormTemplateService {
  constructor({ config }) {
    this.repo = new SqliteRepository(
      path.join(config.dataDir, "form-templates.json"),
    );
    this.versions = new SqliteRepository(
      path.join(config.dataDir, "form-versions.json"),
    );
  }

  list() {
    return this.repo.list();
  }

  async get(id) {
    const item = await this.repo.get(id);
    if (!item) throw AppError.notFound(`서식을 찾을 수 없습니다: ${id}`);
    return item;
  }

  async create(input) {
    const data = normalizeTemplateInput(input);
    const now = new Date().toISOString();
    const item = await this.repo.insert({
      id: createId("form"),
      ...data,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await this.versions.insert({
      id: createId("version"),
      formId: item.id,
      version: 1,
      snapshot: item,
      createdAt: now,
    });
    return item;
  }

  async update(id, input) {
    const previous = await this.get(id);
    const data = normalizeTemplateInput(input);
    if (!(await this.history(id)).length)
      await this.versions.insert({
        id: createId("version"),
        formId: id,
        version: previous.version || 1,
        snapshot: previous,
        createdAt: previous.updatedAt || previous.createdAt,
      });
    const item = await this.repo.update(id, {
      ...data,
      version: (previous.version || 1) + 1,
      updatedAt: new Date().toISOString(),
    });
    await this.versions.insert({
      id: createId("version"),
      formId: id,
      version: item.version,
      snapshot: item,
      createdAt: item.updatedAt,
    });
    return item;
  }

  async remove(id) {
    await this.get(id);
    await this.repo.remove(id);
    return { id };
  }
  async history(id) {
    return (await this.versions.list()).filter((v) => v.formId === id);
  }
  async restore(id, versionId) {
    const version = await this.versions.get(versionId);
    if (!version || version.formId !== id)
      throw AppError.notFound("서식 버전을 찾을 수 없습니다.");
    return this.update(id, version.snapshot);
  }
  close() {
    this.repo.close();
    this.versions.close();
  }
}

module.exports = { FormTemplateService };
