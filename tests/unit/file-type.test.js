'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { matchesFileType } = require('../../src/features/form-job/form-job.service');

test('PDF 는 앞부분에 %PDF- 가 있어야 한다', () => {
  assert.ok(matchesFileType('.pdf', Buffer.from('%PDF-1.7\n...')));
  assert.ok(!matchesFileType('.pdf', Buffer.from('plain text')));
});

test('이미지는 확장자에 맞는 시그니처여야 한다', () => {
  assert.ok(matchesFileType('.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d])));
  assert.ok(matchesFileType('.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])));
  assert.ok(matchesFileType('.tiff', Buffer.from([0x49, 0x49, 0x2a, 0x00])));
  assert.ok(matchesFileType('.bmp', Buffer.from([0x42, 0x4d, 0x00])));
  assert.ok(!matchesFileType('.png', Buffer.from([0xff, 0xd8, 0xff])));
  assert.ok(!matchesFileType('.exe', Buffer.from('MZ')));
});
