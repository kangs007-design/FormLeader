package com.textsense.product;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.*;
import javax.naming.InitialContext;
import javax.sql.DataSource;
import java.io.IOException;
import java.net.URI;
import java.time.Instant;
import java.util.*;

public final class ApiServlet extends HttpServlet {
    private Database db;
    private AuthService auth;
    private Templates forms;
    private Jobs jobs;
    private Workspace workspace;
    private Exports exports;
    @Override public void init() throws ServletException {
        try {
            String origin = Optional.ofNullable(System.getenv("FORMREADER_PUBLIC_URL")).orElse("").replaceAll("/+$", "");
            URI uri = URI.create(origin);
            if (!Set.of("http", "https").contains(Optional.ofNullable(uri.getScheme()).orElse("")) || uri.getHost() == null || uri.getRawUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null || !Optional.ofNullable(uri.getPath()).orElse("").isEmpty())
                throw new IllegalArgumentException("FORMREADER_PUBLIC_URL must be the exact external origin, e.g. https://ocr.internal");
            db = new Database((DataSource) new InitialContext().lookup("java:comp/env/jdbc/FormReader"));
            db.ready();
            auth = new AuthService(db, origin, Optional.ofNullable(System.getenv("FORMREADER_SETUP_TOKEN")).orElse(""));
            forms = new Templates(db);
            jobs = new Jobs(db, forms, new RuntimeConfig());
            exports = new Exports(jobs);
            workspace = new Workspace(db, jobs, exports, auth);
            jobs.workspace = workspace;
        } catch (Exception e) { throw new ServletException("Product startup failed; check JNDI, public origin and schema V001", e); }
    }
    private static ObjectNode capabilities() {
        ObjectNode value = Json.object().put("stage", "java-product").put("release", "0.2.0-SNAPSHOT").put("ocrProcessing", true).put("samples", true);
        value.set("tabs", Json.MAPPER.valueToTree(List.of("dashboard", "job-request", "job-status", "ocr-result", "form-template", "users", "ocr-connect", "operations", "compare")));
        value.set("exports", Json.MAPPER.valueToTree(List.of("json", "xml", "txt", "csv", "xlsx", "pdf", "md")));
        return value;
    }
    @Override protected void service(HttpServletRequest req, HttpServletResponse res) throws IOException {
        res.setContentType("application/json");
        res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "same-origin");
        try {
            if (jobs.config.inputPort > 0 && req.getLocalPort() == jobs.config.inputPort && !req.getServletPath().equals("/files")) throw ApiError.missing();
            if (req.getServletPath().equals("/files")) {
                String path = Optional.ofNullable(req.getPathInfo()).orElse("");
                if (!req.getMethod().equals("GET") || !path.startsWith("/input/") || jobs.config.publicUrl.isEmpty()) throw ApiError.missing();
                String name = path.substring(7);
                if (!jobs.verify(name, req.getParameter("token"))) throw new ApiError(403,"FORBIDDEN","유효한 문서 접근 권한이 없습니다.");
                file(res, Documents.managed(jobs.config.input, name));
                return;
            }
            auth.checkWrite(req);
            JsonNode result = route(req, res);
            if (result != null && !res.isCommitted()) Json.MAPPER.writeValue(res.getOutputStream(), Json.object().put("ok", true).set("data", result));
        } catch (Exception e) {
            if (res.isCommitted()) return;
            int status = e instanceof ApiError error ? error.status : 503;
            String code = e instanceof ApiError error ? error.code : "SERVICE_UNAVAILABLE";
            String message = e instanceof ApiError ? e.getMessage() : "서비스를 이용할 수 없습니다. 운영자에게 문의하세요.";
            if (!(e instanceof ApiError)) getServletContext().log("Product API failed: " + req.getMethod() + " " + req.getPathInfo(), e);
            res.setStatus(status);
            if (status == 429) res.setHeader("Retry-After", "60");
            ObjectNode error = Json.object().put("code", code).put("message", message);
            // Existing auth screens use a top-level error; feature APIs use the standard envelope.
            Json.MAPPER.writeValue(res.getOutputStream(), req.getPathInfo() != null && req.getPathInfo().startsWith("/auth/") ? error : Json.object().put("ok", false).set("error", error));
        }
    }
    private JsonNode route(HttpServletRequest req, HttpServletResponse res) throws Exception {
        String path = Optional.ofNullable(req.getPathInfo()).orElse("").replaceAll("/+$", ""), method = req.getMethod();
        if (method.equals("GET") && path.equals("/health")) return Json.object().put("status", "UP").put("time", Instant.now().toString()).put("stage", "java-product");
        if (method.equals("GET") && path.equals("/ready")) { db.ready(); return Json.object().put("status", "UP").put("database", "MariaDB"); }
        if (method.equals("GET") && path.equals("/account/status")) return auth.status();
        if (method.equals("POST") && (path.startsWith("/auth/") || path.equals("/account/setup"))) {
            auth.throttle(req); ObjectNode body = Json.body(req);
            return switch (path) {
                case "/account/setup" -> auth.setup(req, body);
                case "/auth/sign-up/email" -> auth.signup(body);
                case "/auth/sign-in/email" -> auth.signin(body, res);
                case "/auth/sign-out" -> auth.signout(req, res);
                case "/auth/change-password" -> auth.changePassword(req, body);
                default -> throw ApiError.missing();
            };
        }
        ObjectNode actor = auth.require(req, false);
        if (method.equals("GET") && path.equals("/account/me")) {
            ObjectNode info = Json.object().put("mode", jobs.config.mock ? "mock" : "product"); info.set("user", actor); info.set("capabilities", capabilities()); return info;
        }
        if (method.equals("GET") && path.equals("/capabilities")) return capabilities();
        if (method.equals("GET") && path.equals("/auth/get-session")) return Json.object().set("user", actor);
        if (path.equals("/users") || path.startsWith("/users/")) {
            auth.require(req, true);
            if (path.equals("/users") && method.equals("GET")) return auth.users();
            if (path.matches("/users/[^/]+") && method.equals("PUT")) return auth.updateUser(actor, path.substring(7), Json.body(req));
            throw ApiError.missing();
        }
        if (path.equals("/forms") || path.startsWith("/forms/")) {
            if (!method.equals("GET")) auth.require(req, true);
            String[] parts = path.split("/");
            if (parts.length == 2) {
                if (method.equals("GET")) return forms.list();
                if (method.equals("POST")) return forms.create(Json.body(req));
            }
            if (parts.length == 3) {
                if (method.equals("GET")) return forms.get(parts[2]);
                if (method.equals("PUT")) return forms.update(parts[2], Json.body(req));
                if (method.equals("DELETE")) return forms.remove(parts[2]);
            }
            if (parts.length == 4 && parts[3].equals("history") && method.equals("GET")) return forms.history(parts[2]);
            if (parts.length == 4 && parts[3].equals("restore") && method.equals("POST")) return forms.restore(parts[2], Json.string(Json.body(req), "versionId"));
            throw ApiError.missing();
        }
        if (path.startsWith("/ocr/")) {
            auth.require(req,true);
            if (method.equals("GET") && path.equals("/ocr/connection")) return jobs.client.info();
            if (method.equals("POST") && path.equals("/ocr/connection-test")) return jobs.client.connectionTest();
            throw ApiError.missing();
        }
        String actorId = actor.path("id").asText();
        if (path.equals("/jobs") || path.startsWith("/jobs/")) {
            String[] parts = path.split("/");
            if (parts.length == 2) {
                if (method.equals("GET")) return jobs.list();
                if (method.equals("POST")) return jobs.create(Json.body(req, 57*1024*1024),actorId,actor.path("role").asText().equals("admin"));
            }
            if (parts.length == 3) {
                if (method.equals("GET")) return jobs.get(parts[2]);
                if (method.equals("DELETE")) return jobs.remove(parts[2]);
            }
            if (parts.length == 4) {
                String id=parts[2],action=parts[3];
                if (method.equals("GET")) switch(action) {
                    case "ocr": return jobs.view(id);
                    case "diagnostics": return jobs.diagnostics(id);
                    case "file": file(res,jobs.source(jobs.get(id)));return null;
                    case "image": binary(res,Documents.png(jobs.source(jobs.get(id)),pageNumber(req)),"image/png");return null;
                    case "export": {
                        String format=Optional.ofNullable(req.getParameter("format")).orElse("json");Exports.Result out=exports.export(id,format);
                        res.setHeader("Content-Disposition","attachment; filename=\"result."+format.replaceAll("[^a-z]","")+"\"; filename*=UTF-8''"+java.net.URLEncoder.encode(out.name(),java.nio.charset.StandardCharsets.UTF_8).replace("+","%20"));
                        binary(res,out.bytes(),out.type());return null;
                    }
                }
                if (method.equals("PUT") && action.equals("review")) return jobs.review(id,Json.body(req,16*1024*1024),actorId);
                if (method.equals("POST")) switch(action) {
                    case "retry": return jobs.retry(id,actorId);
                    case "cancel": return jobs.cancel(id,actorId);
                    case "reapply": return jobs.reapply(id,Json.string(Json.body(req),"templateId"),actorId);
                    case "split": return jobs.split(id,Json.body(req).path("groups"),actorId);
                    case "deliver": auth.require(req,true);return workspace.deliver(id,actorId);
                }
            }
            throw ApiError.missing();
        }
        if (path.startsWith("/workspace/")) {
            auth.require(req,true);
            if (method.equals("GET") && path.equals("/workspace/settings")) return workspace.settings();
            if (method.equals("PUT") && path.equals("/workspace/settings")) return workspace.saveSettings(Json.body(req));
            if (method.equals("GET") && path.equals("/workspace/monitor")) return workspace.monitor();
            if (method.equals("POST") && path.equals("/workspace/reset")) return workspace.reset(Json.body(req),actorId);
            throw ApiError.missing();
        }
        if (path.equals("/samples") || path.startsWith("/samples/")) {
            auth.require(req,true);String[] parts=path.split("/");
            if (path.equals("/samples") && method.equals("POST")) return workspace.sample(Json.body(req,57*1024*1024));
            if (path.equals("/samples/preview") && method.equals("POST")) return workspace.preview(Json.body(req),actorId);
            if (parts.length>=3 && method.equals("GET")) {
                ObjectNode sample=workspace.samples.get(parts[2]);
                if (parts.length==3) return sample;
                if (parts.length==4 && parts[3].equals("file")) { file(res,Documents.managed(jobs.config.input,sample.path("storedName").asText()));return null; }
                if (parts.length==4 && parts[3].equals("image")) { binary(res,Documents.png(Documents.managed(jobs.config.input,sample.path("storedName").asText()),pageNumber(req)),"image/png");return null; }
            }
            throw ApiError.missing();
        }
        if (path.equals("/comparisons")) {
            if (method.equals("GET")) return workspace.comparisons();
            if (method.equals("POST")) return workspace.compare(Json.body(req),actorId);
        }
        if (path.matches("/comparisons/[^/]+") && method.equals("GET")) return workspace.comparisons.get(path.substring(13));
        throw ApiError.missing();
    }
    private static int pageNumber(HttpServletRequest req) {
        try { int page=Integer.parseInt(Optional.ofNullable(req.getParameter("page")).orElse("1"));if(page<1||page>10000) throw new NumberFormatException();return page; }
        catch(NumberFormatException e) { throw ApiError.bad("페이지 번호를 확인하세요."); }
    }
    private static void binary(HttpServletResponse res,byte[] bytes,String type) throws IOException {
        res.setContentType(type);res.setContentLengthLong(bytes.length);res.getOutputStream().write(bytes);res.flushBuffer();
    }
    private static void file(HttpServletResponse res,java.nio.file.Path file) throws IOException {
        if(!java.nio.file.Files.isRegularFile(file)) throw ApiError.missing();
        String type=switch(Documents.extension(file.toString())) { case "pdf"->"application/pdf";case "png"->"image/png";case "jpg","jpeg"->"image/jpeg";case "bmp"->"image/bmp";case "tif","tiff"->"image/tiff";default->"application/octet-stream"; };
        res.setContentType(type);res.setContentLengthLong(java.nio.file.Files.size(file));try(var stream=java.nio.file.Files.newInputStream(file)) { stream.transferTo(res.getOutputStream()); }res.flushBuffer();
    }
    @Override public void destroy() { if(jobs!=null) jobs.close(); }
}
