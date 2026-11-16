package com.textsense.product;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import javax.sql.DataSource;
import java.sql.*;

final class Database {
    final DataSource source;
    Database(DataSource source) { this.source = source; }
    @FunctionalInterface interface Work<T> { T run(Connection c) throws Exception; }
    <T> T transaction(Work<T> work) throws Exception {
        try (Connection c = source.getConnection()) {
            c.setAutoCommit(false);
            try { T result = work.run(c); c.commit(); return result; }
            catch (Exception e) { c.rollback(); throw e; }
        }
    }
    static PreparedStatement statement(Connection c, String sql, Object... args) throws SQLException {
        PreparedStatement p = c.prepareStatement(sql);
        try { for (int i = 0; i < args.length; i++) p.setObject(i + 1, args[i]); return p; }
        catch (SQLException e) { p.close(); throw e; }
    }
    static int execute(Connection c, String sql, Object... args) throws SQLException {
        try (PreparedStatement p = statement(c, sql, args)) { return p.executeUpdate(); }
    }
    static void lockAdmin(Connection c) throws SQLException {
        try (PreparedStatement p = statement(c, "SELECT name FROM fr_locks WHERE name='administration' FOR UPDATE"); ResultSet r = p.executeQuery()) {
            if (!r.next()) throw new SQLException("Missing administration lock: apply schema V001 first");
        }
    }
    static ObjectNode get(Connection c, String collection, String id, boolean lock) throws Exception {
        try (PreparedStatement p = statement(c, "SELECT payload FROM fr_records WHERE collection=? AND id=?" + (lock ? " FOR UPDATE" : ""), collection, id); ResultSet r = p.executeQuery()) {
            return r.next() ? Json.parse(r.getString(1)) : null;
        }
    }
    static ArrayNode list(Connection c, String collection) throws Exception {
        ArrayNode items = Json.MAPPER.createArrayNode();
        try (PreparedStatement p = statement(c, "SELECT payload FROM fr_records WHERE collection=? ORDER BY seq", collection); ResultSet r = p.executeQuery()) {
            while (r.next()) items.add(Json.parse(r.getString(1)));
        }
        return items;
    }
    static void insert(Connection c, String collection, ObjectNode data) throws SQLException {
        execute(c, "INSERT INTO fr_records(collection,id,payload) VALUES(?,?,?)", collection, data.path("id").asText(), data.toString());
    }
    void ready() throws Exception {
        try (Connection c = source.getConnection(); PreparedStatement p = statement(c, "SELECT version FROM fr_schema_version WHERE version=1"); ResultSet r = p.executeQuery()) {
            if (!r.next()) throw new SQLException("Apply schema V001 first");
        }
    }
}
