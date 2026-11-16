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
        } catch (Exception e) { throw new ServletException("Product startup failed; check JNDI, public origin and schema V001", e); }
    }
    private static ObjectNode capabilities() {
        ObjectNode value = Json.object().put("stage", "java-migration-1").put("release", "0.1.0-SNAPSHOT").put("ocrProcessing", false).put("samples", false);
        value.set("tabs", Json.MAPPER.valueToTree(List.of("form-template", "users")));
        return value;
    }
    @Override protected void service(HttpServletRequest req, HttpServletResponse res) throws IOException {
        res.setContentType("application/json;charset=UTF-8");
        res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "same-origin");
        try {
            auth.checkWrite(req);
            JsonNode result = route(req, res);
            if (!res.isCommitted()) Json.MAPPER.writeValue(res.getOutputStream(), Json.object().put("ok", true).set("data", result));
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
        if (method.equals("GET") && path.equals("/health")) return Json.object().put("status", "UP").put("time", Instant.now().toString()).put("stage", "java-migration-1");
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
            ObjectNode info = Json.object().put("mode", "product"); info.set("user", actor); info.set("capabilities", capabilities()); return info;
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
        if (path.equals("/jobs") || path.startsWith("/jobs/") || path.startsWith("/ocr/") || path.startsWith("/workspace/") || path.startsWith("/samples"))
            throw new ApiError(501, "MIGRATION_PENDING", "이 기능은 Java 제품판으로 이전 중입니다. Pilot v1에서 이용하세요.");
        throw ApiError.missing();
    }
}
