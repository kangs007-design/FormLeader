'use strict';
/** 공통: 로그/화면/저장 값에서 URI 속 접속 정보(user:password@)를 가린다. */

/** scheme://user:pass@host → scheme://***@host */
function maskUriCredentials(text) {
  return String(text === undefined || text === null ? '' : text).replace(/([a-z][a-z0-9+.\-]*:\/\/)[^\s/@]*@/gi, '$1***@');
}

module.exports = { maskUriCredentials };
