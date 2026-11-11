-- Durable account-mail outbox. Raw tokens and rendered email bodies are intentionally absent.
CREATE TABLE IF NOT EXISTS auth_mail_jobs (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  token_type VARCHAR(24) NOT NULL,
  origin VARCHAR(255) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NOT NULL,
  claimed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NULL,
  safe_error_code VARCHAR(64) NULL,
  CONSTRAINT auth_mail_jobs_user_fk FOREIGN KEY (user_id) REFERENCES customers(id) ON DELETE CASCADE,
  CONSTRAINT auth_mail_jobs_token_type_chk CHECK (token_type IN ('verify_email', 'password_reset')),
  CONSTRAINT auth_mail_jobs_status_chk CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
  KEY auth_mail_jobs_due_idx (status, next_attempt_at)
) ENGINE=InnoDB;
INSERT IGNORE INTO schema_migrations (id, applied_at)
VALUES ('002-mail-queue', UTC_TIMESTAMP(3));
