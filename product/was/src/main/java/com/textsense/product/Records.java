package com.textsense.product;

import com.fasterxml.jackson.databind.node.*;
import java.sql.Connection;

final class Records {
    final Database db;
    final String collection;
    Records(Database db, String collection) { this.db = db; this.collection = collection; }
    ArrayNode list() throws Exception { try (Connection c = db.source.getConnection()) { return Database.list(c, collection); } }
    ObjectNode find(String id) throws Exception { try (Connection c = db.source.getConnection()) { return Database.get(c, collection, id, false); } }
    ObjectNode get(String id) throws Exception { ObjectNode n = find(id); if (n == null) throw ApiError.missing(); return n; }
    ObjectNode insert(ObjectNode n) throws Exception { try (Connection c = db.source.getConnection()) { Database.insert(c, collection, n); } return n; }
    @FunctionalInterface interface Change { ObjectNode apply(ObjectNode previous) throws Exception; }
    ObjectNode change(String id, Change change) throws Exception {
        return db.transaction(c -> {
            ObjectNode previous = Database.get(c, collection, id, true);
            if (previous == null) throw ApiError.missing();
            ObjectNode next = change.apply(previous);
            Database.execute(c, "UPDATE fr_records SET payload=? WHERE collection=? AND id=?", next.toString(), collection, id);
            return next;
        });
    }
    ObjectNode patch(String id, ObjectNode patch) throws Exception { return change(id, n -> { n.setAll(patch); return n; }); }
    ObjectNode put(ObjectNode value) throws Exception {
        try (Connection c = db.source.getConnection()) {
            Database.execute(c, "INSERT INTO fr_records(collection,id,payload) VALUES(?,?,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload)", collection, value.path("id").asText(), value.toString());
        }
        return value;
    }
    void remove(String id) throws Exception { try (Connection c = db.source.getConnection()) { Database.execute(c, "DELETE FROM fr_records WHERE collection=? AND id=?", collection, id); } }
    void clear() throws Exception { try (Connection c = db.source.getConnection()) { Database.execute(c, "DELETE FROM fr_records WHERE collection=?", collection); } }
}
