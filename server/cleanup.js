export async function cleanupAuthState(pool) {
  const statements = [
    "DELETE FROM auth_sessions WHERE absolute_expires_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 DAY) OR idle_expires_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 DAY) OR revoked_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 DAY) LIMIT 500",
    "DELETE FROM auth_tokens WHERE expires_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 DAY) OR consumed_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 DAY) LIMIT 500",
    "DELETE FROM auth_rate_limits WHERE window_started_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 2 DAY) AND (blocked_until IS NULL OR blocked_until < UTC_TIMESTAMP(3)) LIMIT 500",
    "DELETE FROM auth_mail_jobs WHERE status IN ('sent', 'failed', 'cancelled') AND created_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 7 DAY) LIMIT 500",
  ];
  let deleted = 0;
  for (const statement of statements) {
    const [result] = await pool.query(statement);
    deleted += Number(result.affectedRows || 0);
  }
  return deleted;
}
