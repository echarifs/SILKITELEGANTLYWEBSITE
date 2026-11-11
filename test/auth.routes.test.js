import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createAuthRouter } from '../server/auth.js';
import { hashToken, setSessionCookie } from '../server/security.js';

function createMockPool() {
  const sessions = new Map();
  const rates = new Map();
  let nextSessionId = 1;

  async function query(sql, params = []) {
    const normalized = sql.replace(/\s+/gu, ' ').trim();
    if (normalized.startsWith('SELECT s.*, c.id AS customer_id')) {
      const tokenHash = Buffer.isBuffer(params[0]) ? params[0].toString('hex') : '';
      const session = [...sessions.values()].find((value) => value.tokenHash === tokenHash && !value.revoked);
      return [session ? [{
        id: session.id,
        csrf_token: session.csrfToken,
        customer_id: null,
        idle_expires_at: new Date(Date.now() + 60_000),
        absolute_expires_at: new Date(Date.now() + 60_000),
      }] : [], []];
    }
    if (normalized.startsWith('UPDATE auth_sessions SET last_seen_at')) return [{ affectedRows: 1 }, []];
    if (normalized.startsWith('INSERT INTO auth_sessions')) {
      const [id, tokenHash, csrfToken] = params;
      sessions.set(id, { id, tokenHash: tokenHash.toString('hex'), csrfToken, revoked: false });
      return [{ insertId: nextSessionId++ }, []];
    }
    if (normalized.startsWith('INSERT IGNORE INTO auth_rate_limits')) {
      const [bucketKey] = params;
      if (!rates.has(bucketKey)) rates.set(bucketKey, { bucket_key: bucketKey, window_started_at: new Date(), attempts: 0, blocked_until: null });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith('SELECT * FROM auth_rate_limits')) {
      return [[rates.get(params[0]) || null].filter(Boolean), []];
    }
    if (normalized.startsWith('UPDATE auth_rate_limits SET window_started_at')) {
      const row = rates.get(params[0]);
      if (row) { row.window_started_at = new Date(); row.attempts = 1; row.blocked_until = null; }
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith('UPDATE auth_rate_limits SET attempts')) {
      const [attempts, blockedUntil, bucketKey] = params;
      const row = rates.get(bucketKey);
      if (row) { row.attempts = attempts; row.blocked_until = blockedUntil; }
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith('SELECT * FROM customers')) return [[], []];
    if (normalized.startsWith('SELECT id FROM customers')) return [[], []];
    throw new Error(`Unexpected mock SQL: ${normalized}`);
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
      const id = `seed-${nextSessionId++}`;
      sessions.set(id, { id, tokenHash: hashToken(rawToken).toString('hex'), csrfToken, revoked: false });
      return id;
    },
  };
}

async function makeApp({ pool = createMockPool(), allowedOrigins = ['https://app.example'], mail = {} } = {}) {
  const app = express();
  app.use('/auth', await createAuthRouter({ pool, mail, allowedOrigins }));
  return { app, pool };
}

function seedCookie(pool, csrfToken = 'a'.repeat(64), rawToken = 'b'.repeat(64)) {
  pool.seedSession(rawToken, csrfToken);
  let header;
  setSessionCookie({ setHeader(name, value) { if (name === 'Set-Cookie') header = value; } }, rawToken);
  return { header, csrfToken };
}

test('status exposes availability without touching a live database', async () => {
  const { app } = await makeApp();
  const response = await request(app).get('/auth/status');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { signupAvailable: false, emailConfigured: false, sheetsConfigured: false });
});

test('csrf accepts absent Origin only for same-origin fetches and rate-bounds anonymous creation', async () => {
  const { app } = await makeApp();
  const first = await request(app).get('/auth/csrf').set('Sec-Fetch-Site', 'same-origin');
  assert.equal(first.status, 200);
  assert.match(first.body.csrfToken, /^[a-f0-9]{64}$/u);

  const missingFetchMetadata = await request(app).get('/auth/csrf');
  assert.equal(missingFetchMetadata.status, 403);

  const unallowedOrigin = await request(app).get('/auth/csrf').set('Origin', 'https://evil.example');
  assert.equal(unallowedOrigin.status, 403);
});

test('csrf anonymous session creation is bounded by the database-backed rate bucket', async () => {
  const { app } = await makeApp();
  let last;
  for (let index = 0; index < 21; index += 1) {
    last = await request(app).get('/auth/csrf').set('Origin', 'https://app.example');
  }
  assert.equal(last.status, 429);
});

test('state-changing routes require JSON and reject malformed or invalid login cookies', async () => {
  const { app, pool } = await makeApp();
  const seeded = seedCookie(pool);
  const noJson = await request(app)
    .post('/auth/register')
    .set('Origin', 'https://app.example')
    .set('Cookie', seeded.header)
    .send('not-json');
  assert.equal(noJson.status, 415);

  const invalidCookie = await request(app)
    .post('/auth/login')
    .set('Origin', 'https://app.example')
    .set('Content-Type', 'application/json')
    .set('Cookie', '__Host-silkit_session=not-a-token')
    .send({ email: 'customer@example.com', password: 'a sufficiently long private passphrase' });
  assert.equal(invalidCookie.status, 403);
});

test('me returns an empty user for an unauthenticated request', async () => {
  const { app } = await makeApp();
  const response = await request(app).get('/auth/me');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { user: null });
});

test('registration rejects invalid input after origin, JSON, CSRF, and rate checks', async () => {
  const { app, pool } = await makeApp({ mail: { configured: true } });
  const seeded = seedCookie(pool);
  const response = await request(app)
    .post('/auth/register')
    .set('Origin', 'https://app.example')
    .set('Content-Type', 'application/json')
    .set('Cookie', seeded.header)
    .set('X-CSRF-Token', seeded.csrfToken)
    .send({ name: 'Customer', email: 'customer@example.com', password: 'short', termsAccepted: false });
  assert.equal(response.status, 400);
});
