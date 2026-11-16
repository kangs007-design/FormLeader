'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getImageSize } = require('../../src/common/image-size.util');

function png(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}
function jpeg(w, h) { // SOI + APP0(len 4) + SOF0
  const b = Buffer.alloc(30);
  b[0] = 0xff; b[1] = 0xd8;
  b[2] = 0xff; b[3] = 0xe0; b.writeUInt16BE(4, 4);
  b[8] = 0xff; b[9] = 0xc0; b.writeUInt16BE(17, 10); b[12] = 8; b.writeUInt16BE(h, 13); b.writeUInt16BE(w, 15);
  return b;
}
function bmp(w, h) {
  const b = Buffer.alloc(30);
  b[0] = 0x42; b[1] = 0x4d; b.writeInt32LE(w, 18); b.writeInt32LE(-h, 22); // 음수 높이(top-down)
  return b;
}

test('PNG / JPEG / BMP 크기 읽기', () => {
  assert.deepEqual(getImageSize(png(1000, 1400)), { width: 1000, height: 1400 });
  assert.deepEqual(getImageSize(jpeg(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(getImageSize(bmp(300, 200)), { width: 300, height: 200 });
});

test('이미지가 아니거나 깨진 데이터는 null', () => {
  assert.equal(getImageSize(Buffer.from('%PDF-1.4 ...')), null);
  assert.equal(getImageSize(Buffer.from('fake-image-bytes')), null);
  assert.equal(getImageSize(Buffer.alloc(0)), null);
  assert.equal(getImageSize(png(0, 10)), null);
});
