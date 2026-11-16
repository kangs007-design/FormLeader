'use strict';
/** 공통: 이미지 파일 헤더에서 픽셀 크기 읽기 (PNG/JPEG/BMP). 알 수 없으면 null */

function readPng(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47];
  if (buf.length < 24 || !sig.every((b, i) => buf[i] === b)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function readBmp(buf) {
  if (buf.length < 26 || buf[0] !== 0x42 || buf[1] !== 0x4d) return null;
  return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
}

function readJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; } // 패딩
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

function getImageSize(buf) {
  const size = readPng(buf) || readJpeg(buf) || readBmp(buf);
  return size && size.width > 0 && size.height > 0 ? size : null;
}

module.exports = { getImageSize };
