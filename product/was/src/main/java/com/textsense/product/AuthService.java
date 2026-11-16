package com.textsense.product;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.sql.*;
import java.util.*;

final class AuthService {
    private static final String COOKIE = "fr_product_session";
    private static final String PUBLIC = "id,email,name,department,role,status,created_at,updated_at";
    private final Database db;
    private final String origin;
    private final String setupToken;
    AuthService(Database db, String origin, String setupToken) { this.db = db; this.origin = origin; this.setupToken = setupToken; }

    void checkWrite(HttpServletRequest req) {
        if (!Set.of("POST", "PUT", "PATCH", "DELETE").contains(req.getMethod())) return;
        if (!origin.equals(req.getHeader("Origin")) || !"TextSense".equals(req.getHeader("X-Requested-With")))
            throw new ApiError(403, "INVALID_ORIGIN", "허용되지 않은 요청입니다. 페이지를 새로 열어 다시 시도해 주세요.");
    }
    static ObjectNode publicUser(ResultSet r) throws SQLException {
        ObjectNode user = Json.object();
        for (String key : List.of("id", "email", "name", "department", "role", "status")) user.put(key, r.getString(key));
        user.put("createdAt", r.getLong("created_at")).put("updatedAt", r.getLong("updated_at"));
        return user;
    }
    static ObjectNode user(Connection c, String id, boolean lock) throws SQLException {
        try (PreparedStatement p = Database.statement(c, "SELECT " + PUBLIC + " FROM fr_users WHERE id=?" + (lock ? " FOR UPDATE" : ""), id); ResultSet r = p.executeQuery()) {
            return r.next() ? publicUser(r) : null;
        }
    }
    private boolean hasAdmin(Connection c) throws SQLException {
        try (PreparedStatement p = Database.statement(c, "SELECT id FROM fr_users WHERE role='admin' AND status='active' LIMIT 1"); ResultSet r = p.executeQuery()) { return r.next(); }
    }
    ObjectNode status() throws Exception {
        try (Connection c = db.source.getConnection()) {
            return Json.object().put("needsSetup", !hasAdmin(c)).put("approvalRequired", true).put("setupTokenRequired", true);
        }
    }
    private String sessionHash(HttpServletRequest req) throws Exception {
        for (Cookie cookie : Optional.ofNullable(req.getCookies()).orElse(new Cookie[0]))
            if (cookie.getName().equals(COOKIE) && cookie.getValue().matches("[A-Za-z0-9_-]{43}")) return Passwords.sha256(cookie.getValue());
        return "";
    }
    ObjectNode session(HttpServletRequest req) throws Exception {
        String tokenHash = sessionHash(req);
        if (tokenHash.isEmpty()) return null;
        try (Connection c = db.source.getConnection(); PreparedStatement p = Database.statement(c,
                "SELECT u.* FROM fr_sessions s JOIN fr_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.status='active'", tokenHash, System.currentTimeMillis()); ResultSet r = p.executeQuery()) {
            return r.next() ? publicUser(r) : null;
        }
    }
    ObjectNode require(HttpServletRequest req, boolean admin) throws Exception {
        ObjectNode user = session(req);
        if (user == null) throw new ApiError(401, "UNAUTHORIZED", "로그인이 필요합니다.");
        if (admin && !user.path("role").asText().equals("admin")) throw new ApiError(403, "FORBIDDEN", "관리자만 이용할 수 있습니다.");
        return user;
    }
    void throttle(HttpServletRequest req) throws Exception {
        String route = req.getPathInfo();
        int limit = "/auth/sign-in/email".equals(route) ? 8 : "/auth/sign-up/email".equals(route) ? 5 : 30;
        String bucket = Passwords.sha256(req.getRemoteAddr() + "|" + route);
        long now = System.currentTimeMillis();
        int count = db.transaction(c -> {
            Database.execute(c, "DELETE FROM fr_auth_throttle WHERE window_start<?", now - 3_600_000);
            Database.execute(c, "INSERT INTO fr_auth_throttle(bucket,window_start,attempts) VALUES(?,?,1) ON DUPLICATE KEY UPDATE attempts=IF(window_start<? ,1,attempts+1), window_start=IF(window_start<?,VALUES(window_start),window_start)", bucket, now, now - 60_000, now - 60_000);
            try (PreparedStatement p = Database.statement(c, "SELECT attempts FROM fr_auth_throttle WHERE bucket=?", bucket); ResultSet r = p.executeQuery()) { r.next(); return r.getInt(1); }
        });
        if (count > limit) throw new ApiError(429, "TOO_MANY_REQUESTS", "요청이 많습니다. 잠시 후 다시 시도해 주세요.");
    }
    private ObjectNode createUser(Connection c, ObjectNode input, boolean admin) throws Exception {
        String name = Json.string(input, "name").trim(), department = Json.string(input, "department").trim();
        String email = Json.string(input, "email").trim().toLowerCase(Locale.ROOT);
        if (name.isEmpty() || name.length() > 80 || department.length() > 100) throw ApiError.bad("이름은 1~80자, 소속은 100자 이내여야 합니다.");
        if (email.length() > 254 || !email.matches("[^\\s@]+@[^\\s@]+\\.[^\\s@]+")) throw new ApiError(400, "INVALID_EMAIL", "올바른 이메일을 입력하세요.");
        String passwordHash = Passwords.hash(Json.string(input, "password"));
        String id = UUID.randomUUID().toString(); long now = System.currentTimeMillis();
        try { Database.execute(c, "INSERT INTO fr_users(id,email,name,department,password_hash,role,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
            id, email, name, department, passwordHash, admin ? "admin" : "user", admin ? "active" : "pending", now, now); }
        catch (SQLIntegrityConstraintViolationException e) { throw new ApiError(409, "USER_ALREADY_EXISTS", "이미 등록된 이메일입니다."); }
        return user(c, id, false);
    }
    ObjectNode setup(HttpServletRequest req, ObjectNode input) throws Exception {
        if (setupToken.length() < 32) throw new ApiError(503, "SETUP_DISABLED", "운영자가 초기 설정 토큰을 구성해야 합니다.");
        if (!Passwords.equal(setupToken, Optional.ofNullable(req.getHeader("X-Setup-Token")).orElse("")))
            throw new ApiError(403, "INVALID_SETUP_TOKEN", "초기 설정 토큰이 올바르지 않습니다.");
        return db.transaction(c -> {
            Database.lockAdmin(c);
            if (hasAdmin(c)) throw ApiError.bad("최초 관리자 설정이 이미 완료되었습니다.");
            return Json.object().set("user", createUser(c, input, true));
        });
    }
    ObjectNode signup(ObjectNode input) throws Exception {
        return db.transaction(c -> {
            if (!hasAdmin(c)) throw new ApiError(403, "SETUP_REQUIRED", "먼저 관리자 계정을 설정하세요.");
            return Json.object().set("user", createUser(c, input, false));
        });
    }
    private void cookie(HttpServletResponse res, String value, int maxAge) {
        res.addHeader("Set-Cookie", COOKIE + "=" + value + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + maxAge + (origin.startsWith("https://") ? "; Secure" : ""));
    }
    ObjectNode signin(ObjectNode input, HttpServletResponse res) throws Exception {
        String email = Json.string(input, "email").trim().toLowerCase(Locale.ROOT), password = Json.string(input, "password");
        String token = Passwords.token(); long now = System.currentTimeMillis();
        ObjectNode user = db.transaction(c -> {
            ObjectNode found; String stored;
            try (PreparedStatement p = Database.statement(c, "SELECT * FROM fr_users WHERE email=? FOR UPDATE", email); ResultSet r = p.executeQuery()) {
                if (!r.next()) {
                    // Apply the same password derivation cost to unknown accounts.
                    Passwords.hash("unknown-account-" + Passwords.token());
                    throw new ApiError(401, "INVALID_EMAIL_OR_PASSWORD", "이메일 또는 비밀번호가 올바르지 않습니다.");
                }
                found = publicUser(r); stored = r.getString("password_hash");
            }
            if (!Passwords.verify(password, stored)) throw new ApiError(401, "INVALID_EMAIL_OR_PASSWORD", "이메일 또는 비밀번호가 올바르지 않습니다.");
            if (!found.path("status").asText().equals("active")) throw new ApiError(403, "ACCOUNT_NOT_ACTIVE", "관리자 승인을 기다리거나 비활성화된 계정입니다.");
            Database.execute(c, "DELETE FROM fr_sessions WHERE expires_at<=?", now);
            Database.execute(c, "INSERT INTO fr_sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)", Passwords.sha256(token), found.path("id").asText(), now, now + 28_800_000);
            return found;
        });
        cookie(res, token, 28_800);
        return Json.object().set("user", user);
    }
    ObjectNode signout(HttpServletRequest req, HttpServletResponse res) throws Exception {
        try (Connection c = db.source.getConnection()) { Database.execute(c, "DELETE FROM fr_sessions WHERE token_hash=?", sessionHash(req)); }
        cookie(res, "", 0);
        return Json.object().put("success", true);
    }
    ObjectNode changePassword(HttpServletRequest req, ObjectNode input) throws Exception {
        ObjectNode actor = require(req, false);
        String password = Json.string(input, "newPassword"); Passwords.validate(password);
        return db.transaction(c -> {
            String id = actor.path("id").asText(), stored;
            try (PreparedStatement p = Database.statement(c, "SELECT password_hash FROM fr_users WHERE id=? FOR UPDATE", id); ResultSet r = p.executeQuery()) { if (!r.next()) throw ApiError.missing(); stored = r.getString(1); }
            if (!Passwords.verify(Json.string(input, "currentPassword"), stored)) throw new ApiError(400, "INVALID_PASSWORD", "현재 비밀번호가 올바르지 않습니다.");
            Database.execute(c, "UPDATE fr_users SET password_hash=?,updated_at=? WHERE id=?", Passwords.hash(password), System.currentTimeMillis(), id);
            Database.execute(c, "DELETE FROM fr_sessions WHERE user_id=? AND token_hash<>?", id, sessionHash(req));
            return Json.object().put("success", true);
        });
    }
    ArrayNode users() throws Exception {
        ArrayNode list = Json.MAPPER.createArrayNode();
        try (Connection c = db.source.getConnection(); PreparedStatement p = Database.statement(c, "SELECT " + PUBLIC + " FROM fr_users ORDER BY created_at DESC"); ResultSet r = p.executeQuery()) { while (r.next()) list.add(publicUser(r)); }
        return list;
    }
    ObjectNode updateUser(ObjectNode actor, String id, ObjectNode input) throws Exception {
        String role = Json.string(input, "role"), status = Json.string(input, "status");
        if (!Set.of("admin", "user").contains(role) || !Set.of("pending", "active", "disabled").contains(status)) throw ApiError.bad("권한 또는 상태가 올바르지 않습니다.");
        return db.transaction(c -> {
            Database.lockAdmin(c);
            ObjectNode target = user(c, id, true);
            if (target == null) throw ApiError.missing();
            boolean changed = !role.equals(target.path("role").asText()) || !status.equals(target.path("status").asText());
            if (id.equals(actor.path("id").asText()) && changed) throw ApiError.bad("본인 계정의 권한이나 상태는 변경할 수 없습니다.");
            if (target.path("role").asText().equals("admin") && target.path("status").asText().equals("active") && (!role.equals("admin") || !status.equals("active"))) {
                try (PreparedStatement p = Database.statement(c, "SELECT COUNT(*) FROM fr_users WHERE role='admin' AND status='active'"); ResultSet r = p.executeQuery()) { r.next(); if (r.getInt(1) <= 1) throw ApiError.bad("최소 한 명의 활성 관리자가 필요합니다."); }
            }
            Database.execute(c, "UPDATE fr_users SET role=?,status=?,updated_at=? WHERE id=?", role, status, System.currentTimeMillis(), id);
            if (changed) Database.execute(c, "DELETE FROM fr_sessions WHERE user_id=?", id);
            return user(c, id, false);
        });
    }
}
