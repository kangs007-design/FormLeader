package com.textsense.product;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import java.net.*;
import java.net.http.*;
import java.time.Duration;
import java.io.InputStream;
import static com.textsense.product.Nodes.*;

final class TextSense {
    final RuntimeConfig config;
    final HttpClient http;
    record Reply(int status,JsonNode body) {}
    TextSense(RuntimeConfig config) { this.config=config;http=HttpClient.newBuilder().connectTimeout(Duration.ofMillis(config.requestTimeout)).followRedirects(HttpClient.Redirect.NEVER).build(); }
    Reply call(String path,ObjectNode body) throws Exception {
        HttpRequest.Builder request=HttpRequest.newBuilder(URI.create(config.gateway+path)).timeout(Duration.ofMillis(config.requestTimeout)).header("Accept","application/json");
        if(body==null) request.GET();else request.header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(body.toString()));
        try {
            HttpResponse<InputStream> response=http.send(request.build(),HttpResponse.BodyHandlers.ofInputStream());
            try(InputStream stream=response.body()) { byte[] bytes=stream.readNBytes(4*1024*1024+1);if(bytes.length>4*1024*1024) throw new ApiError(502,"UPSTREAM_ERROR","OCR 응답 크기가 제한을 초과했습니다.");JsonNode json;try { json=Json.MAPPER.readTree(bytes); }catch(Exception e) { json=obj(); }return new Reply(response.statusCode(),json==null?obj():json); }
        } catch(java.io.IOException e) { throw new ApiError(502,"ENGINE_CONNECTION","원본은 보관했지만 OCR 서버에 연결하지 못했습니다. VPN·서버 주소·포트를 확인하고 재처리하세요."); }
    }
    Reply build(String input,String output,ObjectNode options) throws Exception {
        ObjectNode extra=obj("url",config.engine,"reqType",options.path("reqType").asText("Document"),"reqOption",options.path("reqOption"),"outputType","json","pages",options.path("pages").asText("all"));
        return call(RuntimeConfig.env("TEXTSENSE_BUILD_PATH","/textsense/api/job/build"),obj("inputUri",input,"outputUri",output,"option",obj("withoutConversion",true),"taskName",config.taskName,"extraJobs",arr(obj("type","textSense","option",extra))));
    }
    Reply status(String id) throws Exception { return call(RuntimeConfig.env("TEXTSENSE_STATUS_PATH","/textsense/api/job/status"),obj("type","OBJECT_ID","id",id)); }
    String failure(String id) {
        try {
            Reply r=call(RuntimeConfig.env("TEXTSENSE_ERRORS_PATH","/textsense/api/job/errors")+"?type=OBJECT_ID&id="+URLEncoder.encode(id,java.nio.charset.StandardCharsets.UTF_8),null);
            StringBuilder message=new StringBuilder("TextSense 작업 실패");for(JsonNode e:items(r.body.path("errors"))) message.append(" / ").append(e.path("code").asText()).append(": ").append(e.path("message").asText(e.path("cause").asText()));return redact(message.toString());
        } catch(Exception e) { return "TextSense 작업 실패 (FAILURE). 입력·결과 저장 경로와 방화벽을 확인하세요."; }
    }
    static String redact(String value) { value=value.replaceAll("(?i)(ftp|https?)://[^/@\\s]+@","$1://***@").replaceAll("[\\r\\n]+"," ");return value.substring(0,Math.min(1000,value.length())); }
    ObjectNode info() {
        return obj("mode",config.mock?"mock":"live","endpoint",config.gateway+"/textsense/api/job/build","statusEndpoint",config.gateway+"/textsense/api/job/status","engineUrl",config.engine,"taskName",config.taskName,"inputUri",config.publicUrl.isEmpty()?config.inputUri:config.publicUrl+"/files/input (서명 URL)","outputUri",config.ftpEnabled?"FTP 결과 수신 :"+config.ftpPort:config.outputUri);
    }
    ObjectNode connectionTest() {
        long start=System.currentTimeMillis();ObjectNode result=info().put("checkedAt",now());
        try { Reply r=build(config.inputUri+"/pdf.pdf",config.outputUri+"/connection-test.json",obj("reqOption",obj()));result.put("reachable",true).put("accepted",r.status>=200&&r.status<300).put("httpStatus",r.status).set("response",r.body);if(r.body.hasNonNull("id")) { Reply s=status(r.body.path("id").asText());result.set("statusCheck",obj("httpStatus",s.status,"status",s.body.path("status"))); } }
        catch(Exception e) { result.put("reachable",false).put("accepted",false).set("error",obj("code","ENGINE_CONNECTION","message",redact(e.getMessage()))); }
        result.put("elapsedMs",System.currentTimeMillis()-start);return result;
    }
    ObjectNode tcp() { try(Socket socket=new Socket()) { URI u=URI.create(config.gateway);socket.connect(new InetSocketAddress(u.getHost(),u.getPort()>0?u.getPort():u.getScheme().equals("https")?443:80),1500);return obj("reachable",true); }catch(Exception e) { return obj("reachable",false,"error","CONNECTION_FAILED"); } }
    static ObjectNode merge(JsonNode base,JsonNode extra) {
        if(!base.isObject()||!extra.isObject()) throw ApiError.bad("엔진 옵션은 JSON 객체여야 합니다.");
        Templates.validateOptions(base);Templates.validateOptions(extra);ObjectNode result=base.deepCopy();
        for(String name:names(extra)) { JsonNode value=extra.get(name);result.set(name,value.isObject()?merge(base.path(name).isObject()?base.path(name):obj(),value):value.deepCopy()); }
        return result;
    }
}
