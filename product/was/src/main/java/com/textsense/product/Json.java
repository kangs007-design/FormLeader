package com.textsense.product;

import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;

final class Json {
    static final ObjectMapper MAPPER = new ObjectMapper();
    static {
        MAPPER.enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
        MAPPER.getFactory().setStreamReadConstraints(StreamReadConstraints.builder()
            .maxNestingDepth(100).maxStringLength(64 * 1024 * 1024).build());
    }
    static ObjectNode object() { return MAPPER.createObjectNode(); }
    static ObjectNode parse(String text) throws IOException {
        JsonNode value = MAPPER.readTree(text);
        if (!(value instanceof ObjectNode object)) throw ApiError.bad("JSON 객체가 필요합니다.");
        return object;
    }
    static ObjectNode body(HttpServletRequest request) throws IOException {
        return body(request, 1_048_576);
    }
    static ObjectNode body(HttpServletRequest request, int limit) throws IOException {
        if (request.getContentType() == null || !request.getContentType().split(";", 2)[0].trim().equalsIgnoreCase("application/json"))
            throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "application/json 형식으로 요청하세요.");
        byte[] bytes = request.getInputStream().readNBytes(limit + 1);
        if (bytes.length > limit) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "요청 크기가 허용 범위를 초과했습니다.");
        try { return parse(new String(bytes, java.nio.charset.StandardCharsets.UTF_8)); }
        catch (IOException e) { throw ApiError.bad("JSON 형식이 올바르지 않습니다."); }
    }
    static String string(JsonNode value, String field) {
        JsonNode node = value.get(field);
        if (node == null || node.isNull()) return "";
        if (!node.isTextual()) throw ApiError.bad(field + " 값은 문자열이어야 합니다.");
        return node.textValue();
    }
}
