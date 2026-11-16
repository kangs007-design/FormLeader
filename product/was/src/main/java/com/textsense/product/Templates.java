package com.textsense.product;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.sql.*;
import java.time.Instant;
import java.util.*;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

final class Templates {
    private static final String FORMS = "form-templates", VERSIONS = "form-versions";
    private static final Set<String> SEARCH = Set.of("FindRegion", "FindLine", "FindWord", "FindRow", "FindRightRow", "FindCol", "FindBottomCol");
    private final Database db;
    Templates(Database db) { this.db = db; }
    static ArrayNode array(JsonNode node, String field, int max) {
        JsonNode value = node.get(field);
        if (value == null) return Json.MAPPER.createArrayNode();
        if (!(value instanceof ArrayNode arr) || arr.size() > max) throw ApiError.bad(field + " 배열의 형식 또는 개수를 확인하세요.");
        return arr;
    }
    static ObjectNode object(JsonNode node, String field) {
        JsonNode value = node.get(field);
        if (value == null) return Json.object();
        if (!(value instanceof ObjectNode obj)) throw ApiError.bad(field + " 값은 객체여야 합니다.");
        return obj;
    }
    private static String regex(JsonNode node, String field) {
        String value = Json.string(node, field);
        if (value.length() > 200) throw ApiError.bad("정규식은 200자 이내여야 합니다.");
        try { Pattern.compile(value); } catch (PatternSyntaxException e) { throw ApiError.bad("정규식이 올바르지 않습니다: " + field); }
        return value;
    }
    private static double number(JsonNode node, String field, Double fallback) {
        JsonNode value = node.get(field);
        if (value == null && fallback != null) return fallback;
        if (value == null || !value.isNumber() || !Double.isFinite(value.doubleValue())) throw ApiError.bad(field + " 값은 숫자여야 합니다.");
        return value.doubleValue();
    }
    private static int integer(JsonNode node, String field, int fallback, int min, int max) {
        double value = number(node, field, (double) fallback);
        if (value != Math.rint(value) || value < min || value > max) throw ApiError.bad(field + " 정수 범위를 확인하세요.");
        return (int) value;
    }
    private static ObjectNode key(JsonNode raw) {
        if (!raw.isObject()) throw ApiError.bad("Key 형식이 올바르지 않습니다.");
        String name = Json.string(raw, "name").trim(), mode = Json.string(raw, "mode");
        if (name.isEmpty()) throw ApiError.bad("Key 이름이 필요합니다.");
        if (mode.isEmpty()) mode = "rect";
        if (!Set.of("rect", "line", "cell", "word").contains(mode)) throw ApiError.bad("추출 방식을 확인하세요.");
        ObjectNode r = object(raw, "rect");
        double x = number(r, "x", null), y = number(r, "y", null), w = number(r, "w", null), h = number(r, "h", null);
        if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) throw ApiError.bad("rect는 0~1 비율 범위 안이어야 합니다.");
        ObjectNode result = Json.object().put("name", name).put("mode", mode).put("page", integer(raw, "page", 1, 1, Integer.MAX_VALUE));
        result.set("rect", Json.object().put("x", x).put("y", y).put("w", w).put("h", h));
        result.put("required", raw.path("required").asBoolean()).put("verify", raw.path("verify").asBoolean());
        for (String field : List.of("pattern", "pattern2", "exceptPattern")) result.put(field, regex(raw, field));
        for (String field : List.of("min", "max")) {
            if (!raw.has(field) || raw.get(field).isNull() || raw.get(field).asText().isEmpty()) result.putNull(field);
            else result.put(field, number(raw, field, null));
        }
        if (!result.path("min").isNull() && !result.path("max").isNull() && result.path("min").asDouble() > result.path("max").asDouble()) throw ApiError.bad("min이 max보다 클 수 없습니다.");
        result.set("exceptValues", array(raw, "exceptValues", 10000).deepCopy());
        for (String field : List.of("lineIndex", "wordIndex", "tableIndex", "row", "column"))
            if (raw.has(field) && !raw.get(field).asText().isEmpty()) result.put(field, integer(raw, field, 0, 0, 10000));
        String search = Json.string(raw, "searchType");
        if (!search.isEmpty() && !SEARCH.contains(search)) throw ApiError.bad("지원하지 않는 SearchAPI 방식입니다.");
        String searchKey = Json.string(raw, "searchKey");
        result.put("searchType", search).put("searchKey", searchKey.substring(0, Math.min(500, searchKey.length())));
        return result;
    }
    private static void uniqueNames(ArrayNode values) {
        Set<String> names = new HashSet<>();
        for (JsonNode value : values) if (!names.add(value.path("name").asText())) throw ApiError.bad("이름이 중복되었습니다.");
    }
    private static void validateOptions(JsonNode options) {
        if (!options.isObject()) throw ApiError.bad("엔진 요청 옵션은 객체여야 합니다.");
        Iterator<String> fields = options.fieldNames();
        while (fields.hasNext()) {
            String name = fields.next();
            if (Set.of("__proto__", "prototype", "constructor").contains(name)) throw ApiError.bad("허용되지 않는 옵션 키입니다.");
            if (options.get(name).isObject()) validateOptions(options.get(name));
        }
        for (JsonNode rule : array(options, "SearchAPI", 500)) {
            String type = Json.string(rule, "Type"); ArrayNode keys = array(rule, "Key", 10000);
            if (!SEARCH.contains(type) || Json.string(rule, "Name").isBlank() || keys.isEmpty()) throw ApiError.bad("SearchAPI Type, Name, Key를 확인하세요.");
            if (type.equals("FindRegion")) {
                if (keys.size() != 2) throw ApiError.bad("SearchAPI 영역 좌표를 확인하세요.");
                for (JsonNode point : keys) {
                    if (!point.isArray() || point.size() != 2) throw ApiError.bad("SearchAPI 영역 좌표를 확인하세요.");
                    for (JsonNode n : point) if (!n.isNumber() || !Double.isFinite(n.asDouble())) throw ApiError.bad("SearchAPI 영역 좌표를 확인하세요.");
                }
            } else for (JsonNode k : keys) if (!k.isTextual() || k.asText().isBlank()) throw ApiError.bad("SearchAPI 탐색 키를 확인하세요.");
        }
    }
    static ObjectNode normalize(ObjectNode input) {
        String name = Json.string(input, "name").trim(), docType = Json.string(input, "docType").trim();
        if (name.isEmpty() || docType.isEmpty()) throw ApiError.bad("서식 이름과 문서유형이 필요합니다.");
        ObjectNode result = Json.object().put("name", name).put("docType", docType);
        ArrayNode keywords = Json.MAPPER.createArrayNode();
        for (JsonNode keyword : array(input, "keywords", 10000)) { if (!keyword.isTextual()) throw ApiError.bad("키워드는 문자열이어야 합니다."); if (!keyword.asText().isBlank()) keywords.add(keyword.asText().trim()); }
        result.set("keywords", keywords);
        ArrayNode keys = Json.MAPPER.createArrayNode(), groups = Json.MAPPER.createArrayNode();
        for (JsonNode raw : array(input, "keys", 200)) keys.add(key(raw));
        for (JsonNode raw : array(input, "groups", 50)) {
            if (!(raw instanceof ObjectNode)) throw ApiError.bad("반복 그룹 형식을 확인하세요.");
            ObjectNode group = key(((ObjectNode) raw).deepCopy().put("mode", "rect"));
            String source = Json.string(raw, "source"); if (source.isEmpty()) source = "lines";
            if (!Set.of("lines", "table").contains(source)) throw ApiError.bad("반복 추출 방식은 lines 또는 table입니다.");
            ArrayNode columns = Json.MAPPER.createArrayNode(), rawColumns = array(raw, "columns", 100);
            if (rawColumns.isEmpty()) throw ApiError.bad("Sub 키를 1~100개 등록하세요.");
            for (int i = 0; i < rawColumns.size(); i++) {
                if (!(rawColumns.get(i) instanceof ObjectNode)) throw ApiError.bad("Sub 키 형식을 확인하세요.");
                ObjectNode col = ((ObjectNode) rawColumns.get(i)).deepCopy().put("page", 1);
                if (!col.has("rect")) col.set("rect", Json.object().put("x", (double) i / rawColumns.size()).put("y", 0).put("w", 1.0 / rawColumns.size()).put("h", 1));
                columns.add(key(col));
            }
            uniqueNames(columns);
            ObjectNode normalized = Json.object().put("name", group.path("name").asText()).put("page", group.path("page").asInt()).put("source", source)
                .put("tableIndex", group.path("tableIndex").asInt()).put("allPages", raw.path("allPages").asBoolean()).put("skipRows", integer(raw, "skipRows", 0, 0, 10000));
            double rowHeight = number(raw, "rowHeight", 0.0);
            if (rowHeight < 0 || rowHeight > 1) throw ApiError.bad("반복 행 높이를 확인하세요.");
            normalized.put("rowHeight", rowHeight).set("rect", group.get("rect")); normalized.set("columns", columns); groups.add(normalized);
        }
        if (keys.isEmpty() && groups.isEmpty()) throw ApiError.bad("Key 또는 반복 그룹을 1개 이상 등록하세요.");
        uniqueNames(keys); uniqueNames(groups);
        result.set("keys", keys); result.set("groups", groups);
        ObjectNode rule = object(input, "documentRule");
        result.set("documentRule", Json.object().put("pattern", regex(rule, "pattern")).put("exceptPattern", regex(rule, "exceptPattern")));
        ObjectNode engine = object(input, "engineRequest");
        String type = Json.string(engine, "reqType");
        if (!type.isEmpty() && !type.matches("[A-Za-z][A-Za-z0-9_]{0,39}")) throw ApiError.bad("엔진 요청 유형을 확인하세요.");
        if (engine.toString().length() > 100000) throw ApiError.bad("엔진 요청 옵션이 너무 큽니다.");
        if (engine.has("reqOption")) validateOptions(engine.get("reqOption"));
        result.set("engineRequest", engine.deepCopy()); result.put("sampleId", Json.string(input, "sampleId"));
        return result;
    }
    ArrayNode list() throws Exception { try (Connection c = db.source.getConnection()) { return Database.list(c, FORMS); } }
    ObjectNode get(String id) throws Exception {
        try (Connection c = db.source.getConnection()) { ObjectNode item = Database.get(c, FORMS, id, false); if (item == null) throw ApiError.missing(); return item; }
    }
    private void snapshot(Connection c, ObjectNode item) throws Exception {
        ObjectNode version = Json.object().put("id", "version_" + UUID.randomUUID()).put("formId", item.path("id").asText()).put("version", item.path("version").asInt()).put("createdAt", item.path("updatedAt").asText());
        version.set("snapshot", item); Database.insert(c, VERSIONS, version);
    }
    ObjectNode create(ObjectNode input) throws Exception {
        ObjectNode item = normalize(input); String now = Instant.now().toString();
        item.put("id", "form_" + UUID.randomUUID()).put("version", 1).put("createdAt", now).put("updatedAt", now);
        return db.transaction(c -> { Database.insert(c, FORMS, item); snapshot(c, item); return item; });
    }
    private ObjectNode update(Connection c, String id, ObjectNode input) throws Exception {
        ObjectNode previous = Database.get(c, FORMS, id, true);
        if (previous == null) throw ApiError.missing();
        ObjectNode item = normalize(input).put("id", id).put("version", previous.path("version").asInt(1) + 1).put("createdAt", previous.path("createdAt").asText()).put("updatedAt", Instant.now().toString());
        Database.execute(c, "UPDATE fr_records SET payload=? WHERE collection=? AND id=?", item.toString(), FORMS, id);
        snapshot(c, item); return item;
    }
    ObjectNode update(String id, ObjectNode input) throws Exception { return db.transaction(c -> update(c, id, input)); }
    ObjectNode remove(String id) throws Exception {
        return db.transaction(c -> { if (Database.get(c, FORMS, id, true) == null) throw ApiError.missing(); Database.execute(c, "DELETE FROM fr_records WHERE collection=? AND id=?", FORMS, id); return Json.object().put("id", id); });
    }
    ArrayNode history(String id) throws Exception {
        get(id); ArrayNode result = Json.MAPPER.createArrayNode();
        try (Connection c = db.source.getConnection(); PreparedStatement p = Database.statement(c, "SELECT payload FROM fr_records WHERE collection=? AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.formId'))=? ORDER BY seq", VERSIONS, id); ResultSet r = p.executeQuery()) { while (r.next()) result.add(Json.parse(r.getString(1))); }
        return result;
    }
    ObjectNode restore(String id, String versionId) throws Exception {
        return db.transaction(c -> {
            ObjectNode version = Database.get(c, VERSIONS, versionId, false);
            if (version == null || !version.path("formId").asText().equals(id)) throw ApiError.missing();
            return update(c, id, (ObjectNode) version.path("snapshot"));
        });
    }
}
