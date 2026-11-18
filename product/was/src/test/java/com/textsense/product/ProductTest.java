package com.textsense.product;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import com.fasterxml.jackson.databind.node.ObjectNode;

class ProductTest {
    private ObjectNode template() throws Exception {
        return Json.parse("""
            {"name":"  견적서  ","docType":"견적","keys":[{"name":"합계","rect":{"x":0,"y":0,"w":1,"h":1}}]}
            """);
    }
    @Test void saltedPasswordsAndOpaqueTokens() throws Exception {
        String password = "Product-test-password-2026";
        String hash = Passwords.hash(password);
        assertNotEquals(hash, Passwords.hash(password));
        assertTrue(Passwords.verify(password, hash));
        assertFalse(Passwords.verify("wrong-password", hash));
        assertEquals(43, Passwords.token().length());
        assertFalse(Passwords.equal(Passwords.token(), Passwords.token()));
        assertThrows(ApiError.class, () -> Passwords.hash("short"));
    }
    @Test void templateNormalizesWithoutLosingGroupsAndEnginePolicy() throws Exception {
        ObjectNode result = Templates.normalize(template());
        assertEquals("견적서", result.path("name").asText());
        assertEquals(1, result.path("keys").get(0).path("page").asInt());
        ObjectNode input = template();
        input.set("groups", Json.MAPPER.readTree("""
            [{"name":"품목","source":"table","rect":{"x":0,"y":0,"w":1,"h":1},"columns":[{"name":"금액","column":1}]}]
            """));
        input.set("engineRequest", Json.MAPPER.readTree("""
            {"reqOption":{"SearchAPI":[{"Type":"FindLine","Name":"날짜","Key":["일시"]}]}}
            """));
        ObjectNode normalized = Templates.normalize(input);
        assertEquals(1, normalized.path("groups").get(0).path("columns").get(0).path("column").asInt());
        assertEquals("날짜", normalized.path("engineRequest").path("reqOption").path("SearchAPI").get(0).path("Name").asText());
    }
    @Test void rejectsInvalidCoordinatesDuplicateNamesAndInvalidPolicies() throws Exception {
        ObjectNode input = template();
        ((ObjectNode) input.path("keys").get(0).path("rect")).put("w", 2);
        assertThrows(ApiError.class, () -> Templates.normalize(input));
        ObjectNode duplicate = template();
        ((com.fasterxml.jackson.databind.node.ArrayNode) duplicate.path("keys")).add(duplicate.path("keys").get(0).deepCopy());
        assertThrows(ApiError.class, () -> Templates.normalize(duplicate));
        ObjectNode invalidPolicy = template();
        invalidPolicy.set("engineRequest", Json.MAPPER.readTree("{\"reqOption\":{\"SearchAPI\":[{\"Type\":\"FindRegion\",\"Name\":\"영역\",\"Key\":[[0,0]]}]}}"));
        assertThrows(ApiError.class, () -> Templates.normalize(invalidPolicy));
        assertThrows(ApiError.class, () -> Json.parse("[]"));
    }
}
