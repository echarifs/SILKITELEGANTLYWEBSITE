-- Additive account schema. server/db.js applies the same statements deterministically.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id VARCHAR(128) NOT NULL PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS customers (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  email VARCHAR(254) NOT NULL,
  name VARCHAR(128) NOT NULL,
  phone VARCHAR(40) NULL,
  password_hash TEXT NOT NULL,
  marketing_consent TINYINT(1) NOT NULL DEFAULT 0,
  verified_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  sheet_row INT NULL,
  sheet_sync_status VARCHAR(16) NOT NULL DEFAULT 'pending',
  sheet_sync_error VARCHAR(64) NULL,
  sheet_sync_attempted_at DATETIME(3) NULL,
  UNIQUE KEY customers_email_unique (email)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  token_hash BINARY(32) NOT NULL UNIQUE,
  csrf_token CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  idle_expires_at DATETIME(3) NOT NULL,
  absolute_expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  CONSTRAINT auth_sessions_user_fk FOREIGN KEY (user_id) REFERENCES customers(id) ON DELETE CASCADE,
  KEY auth_sessions_user_idx (user_id),
  KEY auth_sessions_expiry_idx (idle_expires_at, absolute_expires_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS auth_tokens (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  token_type VARCHAR(24) NOT NULL,
  token_hash BINARY(32) NOT NULL UNIQUE,
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT auth_tokens_user_fk FOREIGN KEY (user_id) REFERENCES customers(id) ON DELETE CASCADE,
  KEY auth_tokens_lookup_idx (token_type, expires_at, consumed_at),
  KEY auth_tokens_user_idx (user_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  bucket_key VARCHAR(320) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  window_started_at DATETIME(3) NOT NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  blocked_until DATETIME(3) NULL
) ENGINE=InnoDB;

INSERT INTO schema_migrations (id, applied_at)
SELECT '001-accounts', UTC_TIMESTAMP(3)
WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE id = '001-accounts');
