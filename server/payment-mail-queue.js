import crypto from 'node:crypto';

export const PAYMENT_MAIL_MIGRATION_ID = '004-payment-mail-queue';
const MAX_ATTEMPTS = 3;
const DEFAULT_BATCH_SIZE = 5;
const VALID_TYPES = new Set(['payment_confirmation', 'refund_notification']);

export async function migratePaymentMailQueue(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A MySQL pool is required');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_mail_jobs (
      id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      webhook_event_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      email_type VARCHAR(32) NOT NULL,
      dedupe_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      attempts INT UNSIGNED NOT NULL DEFAULT 0,
      next_attempt_at DATETIME(3) NOT NULL,
      claimed_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL,
      completed_at DATETIME(3) NULL,
      safe_error_code VARCHAR(64) NULL,
      CONSTRAINT payment_mail_jobs_order_fk FOREIGN KEY (order_id) REFERENCES store_orders(id) ON DELETE CASCADE,
      CONSTRAINT payment_mail_jobs_event_fk FOREIGN KEY (webhook_event_id) REFERENCES payment_webhook_events(event_id) ON DELETE CASCADE,
      CONSTRAINT payment_mail_jobs_type_chk CHECK (email_type IN ('payment_confirmation', 'refund_notification')),
      CONSTRAINT payment_mail_jobs_status_chk CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
      KEY payment_mail_jobs_due_idx (status, next_attempt_at)
    ) ENGINE=InnoDB`);
  await pool.query('INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES (?, UTC_TIMESTAMP(3))', [PAYMENT_MAIL_MIGRATION_ID]);
  return PAYMENT_MAIL_MIGRATION_ID;
}

export async function enqueuePaymentEmail(connection, { orderId, webhookEventId, type } = {}) {
  if (!connection || typeof connection.query !== 'function' || typeof orderId !== 'string'
      || typeof webhookEventId !== 'string' || !VALID_TYPES.has(type)) {
    throw new TypeError('Invalid payment email job');
  }
  const dedupeKey = type === 'payment_confirmation' ? `payment:${orderId}` : `refund:${webhookEventId}`;
  await connection.query(`
    INSERT IGNORE INTO payment_mail_jobs
      (id, order_id, webhook_event_id, email_type, dedupe_key, status, attempts, next_attempt_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', 0, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`, [
    crypto.randomUUID(), orderId, webhookEventId, type, dedupeKey,
  ]);
}

async function claimOne(pool) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(`
      SELECT j.id, j.order_id, j.webhook_event_id, j.email_type, j.attempts,
             o.customer_email, o.customer_name, o.amount_minor, o.currency, o.provider_transaction_id, o.refund_amount_minor
        FROM payment_mail_jobs j
        JOIN store_orders o ON o.id = j.order_id
       WHERE (j.status = 'pending' AND j.next_attempt_at <= UTC_TIMESTAMP(3))
          OR (j.status = 'processing' AND j.claimed_at <= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE))
       ORDER BY j.created_at, j.id
       LIMIT 1 FOR UPDATE`);
    const job = rows[0];
    if (!job) {
      await connection.commit();
      return null;
    }
    const attempts = Number(job.attempts || 0) + 1;
    if (attempts > MAX_ATTEMPTS) {
      await connection.query(`
        UPDATE payment_mail_jobs
           SET status = 'failed', attempts = ?, completed_at = UTC_TIMESTAMP(3), claimed_at = NULL, safe_error_code = 'SMTP_SEND_FAILED'
         WHERE id = ?`, [MAX_ATTEMPTS, job.id]);
      await connection.commit();
      return { skipped: true };
    }
    await connection.query(`
      UPDATE payment_mail_jobs
         SET status = 'processing', attempts = ?, claimed_at = UTC_TIMESTAMP(3), safe_error_code = NULL
       WHERE id = ?`, [attempts, job.id]);
    await connection.commit();
    return { ...job, attempts };
  } catch (error) {
    try { await connection.rollback(); } catch { /* preserve the original error */ }
    throw error;
  } finally {
    connection.release();
  }
}

export async function processPaymentEmailJobs(pool, mail, { batchSize = DEFAULT_BATCH_SIZE } = {}) {
  if (!pool || typeof pool.getConnection !== 'function') throw new TypeError('A MySQL pool is required');
  const limit = Math.max(0, Math.min(DEFAULT_BATCH_SIZE, Number.isFinite(Number(batchSize)) ? Math.floor(Number(batchSize)) : DEFAULT_BATCH_SIZE));
  const results = [];
  for (let index = 0; index < limit; index += 1) {
    let job;
    try {
      job = await claimOne(pool);
    } catch {
      results.push({ status: 'error' });
      break;
    }
    if (!job) break;
    if (job.skipped) {
      results.push({ status: 'skipped' });
      continue;
    }
    const send = job.email_type === 'payment_confirmation' ? mail?.sendPaymentConfirmation : mail?.sendRefundNotification;
    try {
      if (typeof send !== 'function') throw new Error('SMTP_UNAVAILABLE');
      await send.call(mail, {
        email: job.customer_email,
        name: job.customer_name,
        orderId: job.order_id,
        amountMinor: Number(job.amount_minor),
        currency: job.currency,
        transactionId: job.provider_transaction_id,
        refundAmountMinor: job.refund_amount_minor === null ? null : Number(job.refund_amount_minor),
      });
      await pool.query(`
        UPDATE payment_mail_jobs
           SET status = 'sent', completed_at = UTC_TIMESTAMP(3), claimed_at = NULL, safe_error_code = NULL
         WHERE id = ? AND status = 'processing'`, [job.id]);
      results.push({ id: job.id, status: 'sent' });
    } catch {
      const terminal = job.attempts >= MAX_ATTEMPTS;
      try {
        if (terminal) {
          await pool.query(`
            UPDATE payment_mail_jobs
               SET status = 'failed', completed_at = UTC_TIMESTAMP(3), claimed_at = NULL, safe_error_code = 'SMTP_SEND_FAILED'
             WHERE id = ? AND status = 'processing'`, [job.id]);
        } else {
          await pool.query(`
            UPDATE payment_mail_jobs
               SET status = 'pending', next_attempt_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE), claimed_at = NULL, safe_error_code = 'SMTP_SEND_FAILED'
             WHERE id = ? AND status = 'processing'`, [job.id]);
        }
      } catch {
        // A later stale-claim pass will safely recover the job without exposing SMTP details.
      }
      results.push({ id: job.id, status: terminal ? 'failed' : 'pending' });
    }
  }
  return results;
}

export default processPaymentEmailJobs;
