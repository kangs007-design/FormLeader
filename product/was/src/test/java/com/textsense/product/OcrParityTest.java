package com.textsense.product;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static com.textsense.product.Nodes.*;

class OcrParityTest {
    static void same(JsonNode expected,JsonNode actual,String name) {
        assertTrue(expected.equals((a,b)->a.isNumber()&&b.isNumber()?Math.abs(a.asDouble()-b.asDouble())<1e-8?0:1:a.equals(b)?0:1,actual),()->name+"\nexpected: "+expected+"\nactual: "+actual);
    }
    @Test void independentPilotGoldenResults() throws Exception {
        try(var input=getClass().getResourceAsStream("/pilot-parity.json")) {
            assertNotNull(input);
            for(JsonNode fixture:Json.MAPPER.readTree(input)) {
                String name=fixture.path("name").asText();ObjectNode normalized=Ocr.normalize(fixture.path("raw"),fixture.path("sizes"));same(fixture.path("normalized"),normalized,name+" normalization");
                ObjectNode applied=Ocr.apply(normalized,(ObjectNode)fixture.path("template"),fixture.path("engineFields").asBoolean());
                same(fixture.path("extracted"),obj("values",applied.path("values"),"groups",applied.path("groups"),"needsReview",applied.path("needsReview")),name+" extraction");
            }
        }
    }
    @Test void validationAndPartialPages() throws Exception {
        same(arr("필수값 누락"),Ocr.validate(obj("required",true),""),"required");
        same(arr(),Ocr.validate(obj("required",true,"exceptValues",arr("N/A")),"N/A"),"exception");
        same(arr("숫자 아님"),Ocr.validate(obj("min",0),"bad"),"number");
        assertEquals(java.util.List.of(1,2,3,5),Jobs.validatePages("5,1-3,2",5));
        assertThrows(ApiError.class,()->Jobs.validatePages("2-9",5));
        assertThrows(ApiError.class,()->Documents.managed(java.nio.file.Path.of("data"),"../secret.pdf"));
        assertThrows(ApiError.class,()->Documents.decode("invalid base64!"));
    }
}
