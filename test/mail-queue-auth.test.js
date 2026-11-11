import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createAuthRouter } from '../server/auth.js';
import { hashPassword, validatePassword } from '../server/passwords.js';
import { hashToken, setSessionCookie } from '../server/security.js';

function createAuthQueuePool() {
  const sessions = new Map();
  const rates = new Map();
  const customers = new Map();
  const jobs = [];
  let sequence = 0;

  async function query(sql, params = []) {
    const normalized = sql.replace(/\s+/gu, ' ').trim();
    if (normalized.startsWith('SELECT s.*, c.id AS customer_id')) {
      const hash = params[0].toString('hex');
      const session = [...sessions.values()].find((value) => value.tokenHash === hash && !value.revoked);
      return [session ? [{
        id: session.id,
        csrf_token: session.csrfToken,
        customer_id: null,
        idle_expires_at: new Date(Date.now() + 60_000),
        absolute_expires_at: new Date(Date.now() + 60_000),
      }] : [], []];
    }
    if (normalized.startsWith('UPDATE auth_sessions SET last_seen_at')) return [{ affectedRows: 1 }, []];
    if (normalized.startsWith('INSERT IGNORE INTO auth_rate_limits')) {
      const [key] = params;
      if (!rates.has(key)) rates.set(key, { window_started_at: new Date(), attempts: 0, blocked_until: null });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith('SELECT * FROM auth_rate_limits')) return [[rates.get(params[0]) || null].filter(Boolean), []];
    if (normalized.startsWith('UPDATE auth_rate_limits SET window_started_at')) {
      const row = rates.get(params[0]);
      row.window_started_at = new Date();
      row.attempts = 1;
      row.blocked_until = null;
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith('UPDATE auth_rate_limits SET attempts')) {
      const [attempts, blockedUntil, key] = params;
      const row = rates.get(key);
      row.attempts = attempts;
      row.blocked_until = blockedUntil;
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith('SELECT id FROM customers WHERE email')) {
      return [[...customers.values()].filter((customer) => customer.email === params[0]).map(({ id }) => ({ id })), []];
    }
    if (normalized.startsWith('INSERT INTO customers')) {
      const [id, email, name, phone, passwordHash, marketingConsent] = params;
      customers.set(id, { id, email, name, phone, password_hash: passwordHash, marketing_consent: marketingConsent, verified_at: null });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith('INSERT INTO auth_mail_jobs')) {
      const [id, userId, type, origin] = params;
      jobs.push({ id, userId, type, origin });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith('SELECT * FROM customers WHERE email')) {
      return [[...customers.values()].filter((customer) => customer.email === params[0]), []];
    }
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
    seedSession(rawToken, csrfToken) {
      const id = `session-${sequence += 1}`;
      sessions.set(id, { id, tokenHash: hashToken(rawToken).toString('hex'), csrfToken, revoked: false });
      return id;
    },
    addCustomer(customer) {
      customers.set(customer.id, customer);
    },
    jobs,
  };
}

function sessionHeaders(pool) {
  const rawToken = 'b'.repeat(64);
  const csrfToken = 'a'.repeat(64);
  pool.seedSession(rawToken, csrfToken);
  let cookie;
  setSessionCookie({ setHeader(name, value) { if (name === 'Set-Cookie') cookie = value; } }, rawToken);
  return { cookie, csrfToken };
}

async function makeApp(pool, mail) {
  const app = express();
  app.use('/auth', await createAuthRouter({ pool, mail, allowedOrigins: ['https://app.example'] }));
  return app;
}

test('registration and recovery stay generic 202 when SMTP would throw, with no synchronous send', async () => {
  const pool = createAuthQueuePool();
  let sends = 0;
  const mail = {
    configured: true,
    sendVerification: async () => { sends += 1; throw new Error('SMTP failure'); },
    sendPasswordReset: async () => { sends += 1; throw new Error('SMTP failure'); },
  };
  const app = await makeApp(pool, mail);
  const headers = sessionHeaders(pool);
  const password = 'A sufficiently long private customer passphrase 2026';
  assert.equal(validatePassword(password).ok, true);

  const registration = await request(app)
    .post('/auth/register')
    .set('Origin', 'https://app.example')
    .set('Content-Type', 'application/json')
    .set('Cookie', headers.cookie)
    .set('X-CSRF-Token', headers.csrfToken)
    .send({ name: 'Customer', email: 'customer@example.com', password, termsAccepted: true });
  assert.equal(registration.status, 202);
  assert.equal(registration.body.message, 'If registration is available, we will send a verification email to the address provided.');

  const recovery = await request(app)
    .post('/auth/forgot-password')
    .set('Origin', 'https://app.example')
    .set('Content-Type', 'application/json')
    .set('Cookie', headers.cookie)
    .set('X-CSRF-Token', headers.csrfToken)
    .send({ email: 'customer@example.com' });
  assert.equal(recovery.status, 202);
  assert.equal(recovery.body.message, 'If an account matches that address, we will send instructions shortly.');
  assert.equal(sends, 0);
  assert.deepEqual(pool.jobs.map(({ type }) => type), ['verify_email', 'password_reset']);
});

test('recovery never queues a job for an unknown customer and still returns generic 202', async () => {
  const pool = createAuthQueuePool();
  const app = await makeApp(pool, { configured: true });
  const headers = sessionHeaders(pool);
  const response = await request(app)
    .post('/auth/forgot-password')
    .set('Origin', 'https://app.example')
    .set('Content-Type', 'application/json')
    .set('Cookie', headers.cookie)
    .set('X-CSRF-Token', headers.csrfToken)
    .send({ email: 'missing@example.com' });
  assert.equal(response.status, 202);
  assert.equal(pool.jobs.length, 0);
});


test('global email unavailability fails uniformly without queuing or account insertion', async () => {
  const pool = createAuthQueuePool();
  const app = await makeApp(pool, { configured: false });
  const headers = sessionHeaders(pool);
  for (const endpoint of ['register', 'resend-verification', 'forgot-password']) {
    const response = await request(app).post(`/auth/${endpoint}`).set('Origin', 'https://app.example').set('Content-Type', 'application/json').set('Cookie', headers.cookie).set('X-CSRF-Token', headers.csrfToken).send({email:'missing@example.invalid'});
    assert.equal(response.status, 503);
    assert.equal(response.body.error, 'email_unavailable');
  }
  assert.equal(pool.jobs.length, 0);
});
