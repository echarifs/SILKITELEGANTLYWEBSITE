const RETENTION_INDEXES = [
  ['auth_sessions', 'auth_sessions_revoked_cleanup', 'revoked_at'],
  ['auth_sessions', 'auth_sessions_absolute_cleanup', 'absolute_expires_at'],
  ['auth_tokens', 'auth_tokens_expired_cleanup', 'expires_at'],
  ['auth_tokens', 'auth_tokens_consumed_cleanup', 'consumed_at'],
  ['auth_rate_limits', 'auth_rate_limits_cleanup', 'window_started_at, blocked_until'],
  ['auth_mail_jobs', 'auth_mail_jobs_cleanup', 'status, created_at'],
];

export async function migrateRetentionIndexes(pool) {
  const id = '003-auth-retention-indexes';
  const [applied] = await pool.query('SELECT id FROM schema_migrations WHERE id = ? LIMIT 1', [id]);
  if (applied.length) return id;
  for (const [table, index, columns] of RETENTION_INDEXES) {
    const [found] = await pool.query('SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1', [table, index]);
    // Table, index and column names above are committed constants, not visitor input.
    if (!found.length) await pool.query(`ALTER TABLE ${table} ADD INDEX ${index} (${columns})`);
  }
  await pool.query('INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES (?, UTC_TIMESTAMP(3))', [id]);
  return id;
}
