-- Apply once using a DBA account to an empty, dedicated database (utf8mb4).
-- The application account needs SELECT, INSERT, UPDATE, DELETE only.
CREATE TABLE fr_schema_version (version INT PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB;
CREATE TABLE fr_locks (name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY) ENGINE=InnoDB;
INSERT INTO fr_locks VALUES ('administration');

CREATE TABLE fr_users (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  email VARCHAR(254) NOT NULL UNIQUE,
  name VARCHAR(80) NOT NULL,
  department VARCHAR(100) NOT NULL DEFAULT '',
  password_hash VARCHAR(255) CHARACTER SET ascii NOT NULL,
  role ENUM('admin','user') NOT NULL DEFAULT 'user',
  status ENUM('pending','active','disabled') NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE fr_sessions (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  user_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  INDEX(expires_at), INDEX(user_id),
  FOREIGN KEY(user_id) REFERENCES fr_users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE fr_auth_throttle (
  bucket CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  window_start BIGINT NOT NULL,
  attempts INT NOT NULL,
  INDEX(window_start)
) ENGINE=InnoDB;

-- Preserve Pilot JSON shapes and IDs during the staged migration.
-- Collections are never exposed as arbitrary client-selectable tables.
CREATE TABLE fr_records (
  seq BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  collection VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK(JSON_VALID(payload)),
  UNIQUE KEY collection_id(collection,id)
) ENGINE=InnoDB;
INSERT INTO fr_schema_version(version) VALUES (1);
