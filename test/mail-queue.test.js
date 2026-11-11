import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueAccountEmail, migrateMailQueue, processAccountMail } from '../server/mail-queue.js';

function createQueuePool() {
  const jobs = new Map();
  const customers = new Map();
  const tokens = [];
  const queries = [];

  async function query(sql, params = []) {
    const normalized = sql.replace(/\s+/gu, ' ').trim();
    queries.push({ sql: normalized, params });
    if (normalized.startsWith('INSERT INTO auth_mail_jobs')) {
      const [id, userId, tokenType, origin] = params;
      jobs.set(id, { id, user_id: userId, token_type: tokenType, origin, status: 'pending', attempts: 0 });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith('SELECT id, user_id, token_type, origin, status, attempts FROM auth_mail_jobs')) {
      const due = [...jobs.values()].find((job) => job.status === 'pending' || job.status === 'processing');
      return [[due || null].filter(Boolean), []];
    }
    if (normalized.startsWith('SELECT id, email, name, verified_at FROM customers')) {
      return [[customers.get(params[0]) || null].filter(Boolean), []];
    }
    if (normalized.startsWith('UPDATE auth_tokens SET consumed_at')) {
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith('INSERT INTO auth_tokens')) {
      const [id, userId, tokenType, tokenHash] = params;
      tokens.push({ id, userId, tokenType, tokenHash });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith('UPDATE auth_mail_jobs SET status = \'processing\'')) {
      const [attempts, id] = params;
      const job = jobs.get(id);
      job.status = 'processing';
      job.attempts = attempts;
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith('UPDATE auth_mail_jobs SET status = \'sent\'')) {
      const job = jobs.get(params[0]);
      job.status = 'sent';
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith('UPDATE auth_mail_jobs SET status = \'pending\'')) {
      const job = jobs.get(params[1]);
      job.status = 'pending';
      job.safe_error_code = params[0];
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith('UPDATE auth_mail_jobs SET status = \'failed\'')) {
      const job = jobs.get(params[1]);
      job.status = 'failed';
      job.safe_error_code = params[0];
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith('UPDATE auth_mail_jobs SET status = \'cancelled\'')) {
      const job = jobs.get(params[1]);
      job.status = 'cancelled';
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith('CREATE TABLE IF NOT EXISTS auth_mail_jobs')) return [{ affectedRows: 0 }, []];
    if (normalized.startsWith('INSERT IGNORE INTO schema_migrations')) return [{ affectedRows: 1 }, []];
    throw new Error(`Unexpected SQL: ${normalized}`);
  }

  return {
    query,
    async getConnection() {
      return {
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
        query,
      };
    },
    jobs,
    customers,
    tokens,
    queries,
  };
}

test('enqueue stores only account/job metadata and no token or email body', async () => {
  const pool = createQueuePool();
  const id = await enqueueAccountEmail(pool, {
    userId: 'customer-1',
    type: 'password_reset',
    origin: 'https://app.example',
  });
  assert.match(id, /^[0-9a-f-]{36}$/u);
  const insert = pool.queries.find(({ sql }) => sql.startsWith('INSERT INTO auth_mail_jobs'));
  assert.ok(insert);
  assert.equal(insert.params.length, 4);
  assert.equal(insert.sql.includes('token_hash'), false);
  assert.equal(insert.sql.includes('body'), false);
  assert.deepEqual([...pool.jobs.values()][0], {
    id,
    user_id: 'customer-1',
    token_type: 'password_reset',
    origin: 'https://app.example',
    status: 'pending',
    attempts: 0,
  });
});

test('worker creates a fresh hashed token per attempt and fails safely after three SMTP errors', async () => {
  const pool = createQueuePool();
  pool.customers.set('customer-1', { id: 'customer-1', email: 'customer@example.com', name: 'Customer', verified_at: null });
  const id = await enqueueAccountEmail(pool, { userId: 'customer-1', type: 'password_reset', origin: 'https://app.example' });
  const mail = { sendPasswordReset: async ({ token }) => {
    assert.match(token, /^[a-f0-9]{64}$/u);
    throw new Error('SMTP transport details must not escape the worker');
  } };

  await processAccountMail(pool, mail, { allowedOrigins: new Set(['https://app.example']) });
  await processAccountMail(pool, mail, { allowedOrigins: new Set(['https://app.example']) });
  await processAccountMail(pool, mail, { allowedOrigins: new Set(['https://app.example']) });

  assert.equal(pool.jobs.get(id).status, 'failed');
  assert.equal(pool.jobs.get(id).attempts, 3);
  assert.equal(pool.jobs.get(id).safe_error_code, 'SMTP_SEND_FAILED');
  assert.equal(pool.tokens.length, 3);
  assert.equal(new Set(pool.tokens.map(({ tokenHash }) => tokenHash.toString('hex'))).size, 3);
  assert.equal(pool.queries.some(({ params }) => params.some((value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value))), false);
});

test('worker sends a token only for an allowed HTTPS origin and marks already verified jobs cancelled', async () => {
  const pool = createQueuePool();
  pool.customers.set('customer-1', { id: 'customer-1', email: 'customer@example.com', name: 'Customer', verified_at: new Date() });
  const id = await enqueueAccountEmail(pool, { userId: 'customer-1', type: 'verify_email', origin: 'https://app.example' });
  let sent = false;
  await processAccountMail(pool, { sendVerification: async () => { sent = true; } }, { allowedOrigins: new Set(['https://app.example']) });
  assert.equal(sent, false);
  assert.equal(pool.jobs.get(id).status, 'cancelled');
  assert.equal(pool.tokens.length, 0);
});

test('worker persists a recognized SMTP rejection without storing its raw response', async () => {
  const pool = createQueuePool();
  pool.customers.set('customer-1', { id: 'customer-1', email: 'customer@example.com', name: 'Customer', verified_at: null });
  const id = await enqueueAccountEmail(pool, { userId: 'customer-1', type: 'verify_email', origin: 'https://app.example' });
  const mail = { sendVerification: async () => { throw Object.assign(new Error('550 address rejected: private@example.com'), { code: 'SMTP_REJECTED' }); } };

  await processAccountMail(pool, mail, { allowedOrigins: new Set(['https://app.example']), batchSize: 1 });

  const job = pool.jobs.get(id);
  assert.equal(job.status, 'pending');
  assert.equal(job.safe_error_code, 'SMTP_REJECTED');
  assert.equal(JSON.stringify(job).includes('private@example.com'), false);
});

test('migration helper creates schema and records 002 idempotently', async () => {
  const pool = createQueuePool();
  assert.equal(await migrateMailQueue(pool), '002-mail-queue');
  assert.equal(pool.queries.filter(({ sql }) => sql.startsWith('INSERT IGNORE INTO schema_migrations')).length, 1);
});
