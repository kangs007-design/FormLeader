'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTemplateInput } = require('../../src/features/form-template/form-template.validator');

const valid = () => ({
  name: '청구서', docType: 'invoice', keywords: ['청구서', ' '],
  keys: [{ name: 'docNo', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.05 }, required: true }],
});

test('정상 입력은 기본값과 함께 정규화', () => {
  const out = normalizeTemplateInput(valid());
  assert.deepEqual(out.keywords, ['청구서']);
  assert.equal(out.keys[0].page, 1);
  assert.equal(out.keys[0].mode, 'rect');
  assert.equal(out.keys[0].min, null);
});

test('필수값/중복/범위 오류는 400', () => {
  const bad = (mut, re) => {
    const v = valid(); mut(v);
    assert.throws(() => normalizeTemplateInput(v), (e) => e.status === 400 && re.test(e.message));
  };
  bad((v) => { v.name = ''; }, /서식 이름/);
  bad((v) => { v.docType = ''; }, /문서유형/);
  bad((v) => { v.keys = []; }, /1개 이상/);
  bad((v) => { v.keys[0].rect.w = 0; }, /rect/);
  bad((v) => { v.keys[0].rect = { x: 0.9, y: 0.1, w: 0.5, h: 0.1 }; }, /0~1/);
  bad((v) => { v.keys[0].mode = 'zzz'; }, /mode/);
  bad((v) => { v.keys[0].pattern = '('; }, /정규식/);
  bad((v) => { v.keys[0].min = 10; v.keys[0].max = 1; }, /min/);
  bad((v) => { v.keys.push({ ...v.keys[0] }); }, /중복/);
});
