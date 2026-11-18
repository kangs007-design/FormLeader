package com.textsense.product;

final class ApiError extends RuntimeException {
    final int status;
    final String code;
    ApiError(int status, String code, String message) { super(message); this.status = status; this.code = code; }
    static ApiError bad(String message) { return new ApiError(400, "BAD_REQUEST", message); }
    static ApiError missing() { return new ApiError(404, "NOT_FOUND", "요청한 항목을 찾을 수 없습니다."); }
}
