package com.textsense.product;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import java.time.Instant;
import java.util.*;

final class Nodes {
    static ObjectNode obj(Object... pairs) {
        ObjectNode n = Json.object();
        for (int i = 0; i < pairs.length; i += 2) n.set((String) pairs[i], pairs[i + 1] instanceof JsonNode j ? j : Json.MAPPER.valueToTree(pairs[i + 1]));
        return n;
    }
    static ArrayNode arr(Object... values) { ArrayNode a = Json.MAPPER.createArrayNode(); for (Object v : values) a.add(v instanceof JsonNode j ? j : Json.MAPPER.valueToTree(v)); return a; }
    static List<JsonNode> items(JsonNode n) { List<JsonNode> r = new ArrayList<>(); if (n != null && n.isArray()) n.forEach(r::add); return r; }
    static Set<String> names(JsonNode n) { Set<String> r = new LinkedHashSet<>(); n.fieldNames().forEachRemaining(r::add); return r; }
    static String now() { return Instant.now().toString(); }
    static String id(String prefix) { return prefix + "_" + UUID.randomUUID(); }
    static String text(JsonNode n) { return n == null || n.isNull() || n.isMissingNode() ? "" : n.asText(); }
    static int page(String key) { try { return Integer.parseInt(key.replaceAll("\\D", "")); } catch (Exception e) { return 0; } }
    static ObjectNode object(JsonNode n) { if (!(n instanceof ObjectNode o)) throw ApiError.bad("JSON 객체 형식을 확인하세요."); return o; }
}
