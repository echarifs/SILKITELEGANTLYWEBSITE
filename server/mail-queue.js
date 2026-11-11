import crypto from 'node:crypto';
import { hashToken, isAllowedOrigin, randomToken } from './security.js';

const MIGRATION_ID = '002-mail-queue';
const RETRY_DELAY_MS = 5 * 60 * 1000;
const STALE_CLAIM_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const DEFAULT_BATCH_SIZE = 5;
const TOKEN_TYPES = new Set(['verify_email', 'password_reset']);
const SAFE_ERRORS = new Set(['SMTP_SEND_FAILED', 'SMTP_UNAVAILABLE', 'SMTP_AUTHENTICATION_FAILED', 'SMTP_CONNECTION_FAILED', 'SMTP_REJECTED', 'SMTP_TEMPORARY_FAILURE', 'INVALID_ORIGIN', 'CUSTOMER_MISSING', 'ALREADY_VERIFIED']);


function transaction(pool, work) {
  return (async () => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      try { await connection.rollback(); } catch { /* preserve the original failure */ }
      throw error;
    } finally {
      connection.release();
    }
  })();
}

function normalizedOrigin(origin) {
  if (typeof origin !== 'string' || origin.length > 255) return null;
  try {
    const parsed = new URL(origin);
    const loopbackDev = parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
    if ((parsed.protocol !== 'https:' && !loopbackDev) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function safeErrorCode(code) {
  return SAFE_ERRORS.has(code) ? code : 'SMTP_SEND_FAILED';
}

function asAllowedOrigins(allowedOrigins) {
  if (allowedOrigins instanceof Set) return allowedOrigins;
  if (Array.isArray(allowedOrigins)) return new Set(allowedOrigins);
  return new Set();
}

export async function migrateMailQueue(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A MySQL pool is required');
  await pool.query(`
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
    ) ENGINE=InnoDB`);
  await pool.query('INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES (?, UTC_TIMESTAMP(3))', [MIGRATION_ID]);
  return MIGRATION_ID;
}

export async function enqueueAccountEmail(pool, { userId, type, origin } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A MySQL pool is required');
  if (typeof userId !== 'string' || !TOKEN_TYPES.has(type)) throw new TypeError('Invalid account email job');
  const safeOrigin = normalizedOrigin(origin);
  if (!safeOrigin) throw new TypeError('Invalid account email origin');
  const id = crypto.randomUUID();
  await pool.query(`
    INSERT INTO auth_mail_jobs
      (id, user_id, token_type, origin, status, attempts, next_attempt_at, created_at)
    VALUES (?, ?, ?, ?, 'pending', 0, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`, [id, userId, type, safeOrigin]);
  return id;
}

async function claimOne(pool, allowedOrigins) {
  return transaction(pool, async (connection) => {
    const [jobs] = await connection.query(`
      SELECT id, user_id, token_type, origin, status, attempts
        FROM auth_mail_jobs
       WHERE (status = 'pending' AND next_attempt_at <= UTC_TIMESTAMP(3))
          OR (status = 'processing' AND claimed_at <= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE))
       ORDER BY created_at, id
       LIMIT 1`);
    const candidate = jobs[0];
    if (!candidate) return null;

    // Reset, login and verification also lock the customer first. Recheck the
    // tentative job under lock afterwards so two workers cannot claim it.
    const [customers] = await connection.query(
      'SELECT id, email, name, verified_at FROM customers WHERE id = ? LIMIT 1 FOR UPDATE',
      [candidate.user_id],
    );
    const [lockedJobs] = await connection.query(`
      SELECT id, user_id, token_type, origin, status, attempts FROM auth_mail_jobs
       WHERE id = ? AND (
         (status = 'pending' AND next_attempt_at <= UTC_TIMESTAMP(3)) OR
         (status = 'processing' AND claimed_at <= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE))
       ) LIMIT 1 FOR UPDATE`, [candidate.id]);
    const job = lockedJobs[0];
    if (!job) return { skipped: true };
    const customer = customers[0];
    const origin = normalizedOrigin(job.origin);
    if (!customer) {
      await connection.query(`UPDATE auth_mail_jobs SET status = 'cancelled', completed_at = UTC_TIMESTAMP(3), safe_error_code = ? WHERE id = ?`, ['CUSTOMER_MISSING', job.id]);
      return { skipped: true };
    }
    if (!isAllowedOrigin(origin, allowedOrigins)) {
      await connection.query(`UPDATE auth_mail_jobs SET status = 'cancelled', completed_at = UTC_TIMESTAMP(3), safe_error_code = ? WHERE id = ?`, ['INVALID_ORIGIN', job.id]);
      return { skipped: true };
    }
    if (job.token_type === 'verify_email' && customer.verified_at) {
      await connection.query(`UPDATE auth_mail_jobs SET status = 'cancelled', completed_at = UTC_TIMESTAMP(3), safe_error_code = ? WHERE id = ?`, ['ALREADY_VERIFIED', job.id]);
      return { skipped: true };
    }
    if (!TOKEN_TYPES.has(job.token_type) || !customer.email) {
      await connection.query(`UPDATE auth_mail_jobs SET status = 'cancelled', completed_at = UTC_TIMESTAMP(3), safe_error_code = ? WHERE id = ?`, ['CUSTOMER_MISSING', job.id]);
      return { skipped: true };
    }

    const attempts = Number(job.attempts || 0) + 1;
    if (attempts > MAX_ATTEMPTS) {
      await connection.query(`UPDATE auth_mail_jobs SET status = 'failed', attempts = ?, completed_at = UTC_TIMESTAMP(3), safe_error_code = ? WHERE id = ?`, [MAX_ATTEMPTS, 'SMTP_SEND_FAILED', job.id]);
      return { skipped: true };
    }

    const token = randomToken(32);
    await connection.query(`
      UPDATE auth_mail_jobs
         SET status = 'processing', attempts = ?, claimed_at = UTC_TIMESTAMP(3), safe_error_code = NULL
       WHERE id = ?`, [attempts, job.id]);
    await connection.query(
      'UPDATE auth_tokens SET consumed_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND token_type = ? AND consumed_at IS NULL',
      [customer.id, job.token_type],
    );
    await connection.query(`
      INSERT INTO auth_tokens (id, user_id, token_type, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 MINUTE), UTC_TIMESTAMP(3))`,
    [crypto.randomUUID(), customer.id, job.token_type, hashToken(token)]);
    return { job, customer, origin, token, attempts };
  });
}

export async function processAccountMail(pool, mail, { allowedOrigins = new Set(), batchSize = DEFAULT_BATCH_SIZE } = {}) {
  if (!pool || typeof pool.getConnection !== 'function') throw new TypeError('A MySQL pool is required');
  const origins = asAllowedOrigins(allowedOrigins);
  const limit = Math.max(0, Math.min(DEFAULT_BATCH_SIZE, Number.isFinite(Number(batchSize)) ? Math.floor(Number(batchSize)) : DEFAULT_BATCH_SIZE));
  const results = [];
  for (let index = 0; index < limit; index += 1) {
    let claimed;
    try {
      claimed = await claimOne(pool, origins);
    } catch {
      results.push({ status: 'error' });
      break;
    }
    if (!claimed) break;
    if (claimed.skipped) {
      results.push({ status: 'skipped' });
      continue;
    }
    const send = claimed.job.token_type === 'verify_email' ? mail?.sendVerification : mail?.sendPasswordReset;
    let sent = false;
    try {
      if (typeof send !== 'function') throw new Error('SMTP_UNAVAILABLE');
      await send.call(mail, {
        email: claimed.customer.email,
        name: claimed.customer.name,
        token: claimed.token,
        origin: claimed.origin,
      });
      sent = true;
      await pool.query(`
        UPDATE auth_mail_jobs
           SET status = 'sent', completed_at = UTC_TIMESTAMP(3), claimed_at = NULL, safe_error_code = NULL
         WHERE id = ? AND status = 'processing'`, [claimed.job.id]);
      results.push({ id: claimed.job.id, status: 'sent' });
    } catch (error) {
      const terminal = claimed.attempts >= MAX_ATTEMPTS;
      const errorCode = safeErrorCode(error?.code);
      try {
        if (terminal) {
          await pool.query(`
            UPDATE auth_mail_jobs
               SET status = 'failed', completed_at = UTC_TIMESTAMP(3), claimed_at = NULL, safe_error_code = ?
             WHERE id = ? AND status = 'processing'`, [errorCode, claimed.job.id]);
        } else {
          await pool.query(`
            UPDATE auth_mail_jobs
               SET status = 'pending', next_attempt_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE), claimed_at = NULL, safe_error_code = ?
             WHERE id = ? AND status = 'processing'`, [errorCode, claimed.job.id]);
        }
      } catch {
        // A later stale-claim pass safely recovers this job; never expose mail errors.
      }
      results.push({ id: claimed.job.id, status: terminal ? 'failed' : 'pending' });
    } finally {
      claimed.token = null;
      if (!sent) claimed.customer = null;
    }
  }
  return results;
}

export { MIGRATION_ID, MAX_ATTEMPTS, RETRY_DELAY_MS, STALE_CLAIM_MS };
export default processAccountMail;
