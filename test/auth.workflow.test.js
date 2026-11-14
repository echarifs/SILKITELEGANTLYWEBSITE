import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { resolvePublicAppOrigin } from '../server/app.js';
import { createAuthRouter } from '../server/auth.js';
import { hashToken } from '../server/security.js';
import { hashPassword } from '../server/passwords.js';

const ORIGIN = 'https://app.example';
const EMAIL = 'test@example.invalid';
const NAME = 'Test';
const OLD_PASSWORD = 'Orbit!Canyon7Glass#Lantern';
const NEW_PASSWORD = 'Harbor!Velvet9Comet#Pine';

function compact(sql) {
  return sql.replace(/\s+/gu, ' ').trim();
}

function hex(value) {
  return Buffer.isBuffer(value) ? value.toString('hex') : value;
}

function createStrictMockPool() {
  const customers = new Map();
  const sessions = new Map();
  const tokens = new Map();
  const rates = new Map();
  const jobs = new Map();
  const queries = [];

  function customerByEmail(email) {
    return [...customers.values()].find((customer) => customer.email === email) || null;
  }

  function tokenByHash(tokenHash, type) {
    return [...tokens.values()].find((token) => token.token_hash === hex(tokenHash) && token.token_type === type) || null;
  }

  function sessionByHash(tokenHash) {
    return [...sessions.values()].find((session) => (
      session.token_hash === hex(tokenHash)
      && !session.revoked_at
      && session.idle_expires_at.getTime() > Date.now()
      && session.absolute_expires_at.getTime() > Date.now()
    )) || null;
  }

  function assertParams(params, length) {
    assert.equal(params.length, length, `unexpected parameter count for SQL fixture: ${length}`);
  }

  async function query(sql, params = []) {
    const normalized = compact(sql);
    queries.push({ sql: normalized, params });

    if (normalized.startsWith('SELECT s.*, c.id AS customer_id')) {
      assertParams(params, 1);
      const session = sessionByHash(params[0]);
      if (!session) return [[], []];
      const customer = session.user_id ? customers.get(session.user_id) : null;
      return [[{
        id: session.id,
        csrf_token: session.csrf_token,
        customer_id: customer?.verified_at ? customer.id : null,
        email: customer?.verified_at ? customer.email : null,
        name: customer?.verified_at ? customer.name : null,
        phone: customer?.verified_at ? customer.phone : null,
        marketing_consent: customer?.verified_at ? customer.marketing_consent : null,
        verified_at: customer?.verified_at || null,
        created_at: customer?.created_at || null,
        sheet_sync_status: customer?.sheet_sync_status || null,
        sheet_sync_error: customer?.sheet_sync_error || null,
        token_hash: session.token_hash,
        user_id: session.user_id,
        last_seen_at: session.last_seen_at,
        idle_expires_at: session.idle_expires_at,
        absolute_expires_at: session.absolute_expires_at,
      }], []];
    }

    if (normalized.startsWith('UPDATE auth_sessions SET last_seen_at')) {
      assertParams(params, 1);
      const session = sessions.get(params[0]);
      if (session) session.last_seen_at = new Date();
      return [{ affectedRows: session ? 1 : 0 }, []];
    }

    if (normalized.startsWith('INSERT INTO auth_sessions')) {
      assertParams(params, 8);
      const [id, tokenHash, csrfToken, userId, createdAt, lastSeenAt, idleExpiresAt, absoluteExpiresAt] = params;
      sessions.set(id, {
        id,
        token_hash: hex(tokenHash),
        csrf_token: csrfToken,
        user_id: userId,
        created_at: createdAt,
        last_seen_at: lastSeenAt,
        idle_expires_at: idleExpiresAt,
        absolute_expires_at: absoluteExpiresAt,
        revoked_at: null,
      });
      return [{ insertId: id }, []];
    }

    if (normalized.startsWith('UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE id = ?')) {
      assertParams(params, 1);
      const session = sessions.get(params[0]);
      if (session) session.revoked_at = new Date();
      return [{ affectedRows: session ? 1 : 0 }, []];
    }

    if (normalized.startsWith('UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ?')) {
      assertParams(params, 1);
      let affectedRows = 0;
      for (const session of sessions.values()) {
        if (session.user_id === params[0] && !session.revoked_at) {
          session.revoked_at = new Date();
          affectedRows += 1;
        }
      }
      return [{ affectedRows }, []];
    }

    if (normalized.startsWith('INSERT IGNORE INTO auth_rate_limits')) {
      assertParams(params, 1);
      if (!rates.has(params[0])) rates.set(params[0], {
        bucket_key: params[0], window_started_at: new Date(), attempts: 0, blocked_until: null,
      });
      return [{ affectedRows: 1 }, []];
    }

    if (normalized.startsWith('SELECT * FROM auth_rate_limits')) {
      assertParams(params, 1);
      return [[rates.get(params[0]) || null].filter(Boolean), []];
    }

    if (normalized.startsWith('UPDATE auth_rate_limits SET window_started_at')) {
      assertParams(params, 1);
      const row = rates.get(params[0]);
      if (row) Object.assign(row, { window_started_at: new Date(), attempts: 1, blocked_until: null });
      return [{ affectedRows: 1 }, []];
    }

    if (normalized.startsWith('UPDATE auth_rate_limits SET attempts')) {
      assertParams(params, 3);
      const [attempts, blockedUntil, bucketKey] = params;
      const row = rates.get(bucketKey);
      if (row) Object.assign(row, { attempts, blocked_until: blockedUntil });
      return [{ affectedRows: 1 }, []];
    }

    if (normalized.startsWith('SELECT id FROM customers WHERE email = ?')) {
      assertParams(params, 1);
      const customer = customerByEmail(params[0]);
      return [[customer ? { id: customer.id } : null].filter(Boolean), []];
    }

    if (normalized.startsWith('INSERT INTO customers')) {
      assertParams(params, 6);
      const [id, email, name, phone, passwordHash, marketingConsent] = params;
      if (customerByEmail(email)) {
        const error = new Error('duplicate customer');
        error.code = 'ER_DUP_ENTRY';
        throw error;
      }
      customers.set(id, {
        id, email, name, phone, password_hash: passwordHash, marketing_consent: marketingConsent,
        created_at: new Date(), verified_at: null, sheet_sync_status: 'pending', sheet_sync_error: null,
        address_line1: null, address_line2: null, city: null, postal_code: null, country: null,
      });
      return [{ insertId: id }, []];
    }

    if (normalized.startsWith('SELECT * FROM customers WHERE email = ?')) {
      assertParams(params, 1);
      return [[customerByEmail(params[0])].filter(Boolean), []];
    }

    if (normalized.startsWith('SELECT * FROM customers WHERE id = ?')) {
      assertParams(params, 1);
      return [[customers.get(params[0]) || null].filter(Boolean), []];
    }

    if (normalized.startsWith('SELECT id, password_hash, verified_at FROM customers WHERE id = ?')) {
      assertParams(params, 1);
      const customer = customers.get(params[0]);
      return [[customer ? { id: customer.id, password_hash: customer.password_hash, verified_at: customer.verified_at } : null].filter(Boolean), []];
    }

    if (normalized.startsWith('SELECT id, email, name FROM customers WHERE id = ?')) {
      assertParams(params, 1);
      const customer = customers.get(params[0]);
      return [[customer ? { id: customer.id, email: customer.email, name: customer.name } : null].filter(Boolean), []];
    }

    if (normalized.startsWith('UPDATE customers SET verified_at')) {
      assertParams(params, 1);
      const customer = customers.get(params[0]);
      if (customer && !customer.verified_at) customer.verified_at = new Date();
      return [{ affectedRows: customer ? 1 : 0 }, []];
    }

    if (normalized.startsWith('UPDATE customers SET name = ?')) {
      assertParams(params, 5);
      const [name, phone, email, marketingConsent, userId] = params;
      const customer = customers.get(userId);
      if (customer && email !== customer.email && customerByEmail(email)) {
        // Mirror the customers.email UNIQUE constraint the real tables enforce.
        const error = new Error('duplicate customer email');
        error.code = 'ER_DUP_ENTRY';
        throw error;
      }
      if (customer) {
        Object.assign(customer, { name, phone, email, marketing_consent: marketingConsent });
        if (normalized.includes("sheet_sync_status = 'pending'")) customer.sheet_sync_status = 'pending';
      }
      return [{ affectedRows: customer ? 1 : 0 }, []];
    }

    if (normalized.startsWith('UPDATE customers SET address_line1')) {
      assertParams(params, 6);
      const [addressLine1, addressLine2, city, postalCode, country, userId] = params;
      const customer = customers.get(userId);
      if (customer) {
        Object.assign(customer, {
          address_line1: addressLine1, address_line2: addressLine2,
          city, postal_code: postalCode, country,
        });
      }
      return [{ affectedRows: customer ? 1 : 0 }, []];
    }

    if (normalized.startsWith('UPDATE customers SET password_hash = ?')) {
      assertParams(params, 2);
      const [passwordHash, userId] = params;
      const customer = customers.get(userId);
      if (customer) {
        customer.password_hash = passwordHash;
        customer.verified_at ||= new Date();
      }
      return [{ affectedRows: customer ? 1 : 0 }, []];
    }

    if (normalized.startsWith('INSERT INTO auth_mail_jobs')) {
      assertParams(params, 4);
      const [id, userId, tokenType, origin] = params;
      jobs.set(id, { id, user_id: userId, token_type: tokenType, origin, status: 'pending' });
      return [{ affectedRows: 1 }, []];
    }

    if (normalized.startsWith('SELECT t.user_id FROM auth_tokens t')) {
      assertParams(params, 2);
      const token = tokenByHash(params[0], params[1]);
      return [[token ? { user_id: token.user_id } : null].filter(Boolean), []];
    }

    if (normalized.startsWith('SELECT id AS token_id, user_id, expires_at, consumed_at FROM auth_tokens')) {
      assertParams(params, 3);
      const token = tokenByHash(params[0], params[1]);
      return [[token && token.user_id === params[2] ? {
        token_id: token.id, user_id: token.user_id, expires_at: token.expires_at, consumed_at: token.consumed_at,
      } : null].filter(Boolean), []];
    }

    if (normalized.startsWith('UPDATE auth_tokens SET consumed_at = UTC_TIMESTAMP(3) WHERE id = ?')) {
      assertParams(params, 1);
      const token = tokens.get(params[0]);
      if (token) token.consumed_at = new Date();
      return [{ affectedRows: token ? 1 : 0 }, []];
    }

    if (normalized.startsWith('SELECT c.id, c.name, c.email FROM auth_tokens t JOIN customers c')) {
      assertParams(params, 2);
      const token = tokenByHash(params[0], params[1]);
      const customer = token ? customers.get(token.user_id) : null;
      if (!token || token.consumed_at || token.expires_at.getTime() <= Date.now() || !customer) return [[], []];
      return [[{ id: customer.id, name: customer.name, email: customer.email }], []];
    }

    if (normalized.startsWith('SELECT id, user_id, expires_at, consumed_at FROM auth_tokens')) {
      assertParams(params, 2);
      const token = tokenByHash(params[0], params[1]);
      return [[token ? {
        id: token.id, user_id: token.user_id, expires_at: token.expires_at, consumed_at: token.consumed_at,
      } : null].filter(Boolean), []];
    }

    if (normalized.startsWith('UPDATE auth_tokens SET consumed_at = UTC_TIMESTAMP(3) WHERE user_id = ?')) {
      assertParams(params, 1);
      let affectedRows = 0;
      for (const token of tokens.values()) {
        if (token.user_id === params[0] && !token.consumed_at) {
          token.consumed_at = new Date();
          affectedRows += 1;
        }
      }
      return [{ affectedRows }, []];
    }

    if (normalized.startsWith('UPDATE auth_mail_jobs SET status = \'cancelled\'')) {
      assertParams(params, 1);
      let affectedRows = 0;
      for (const job of jobs.values()) {
        if (job.user_id === params[0] && ['pending', 'processing'].includes(job.status)) {
          job.status = 'cancelled';
          affectedRows += 1;
        }
      }
      return [{ affectedRows }, []];
    }

    throw new Error(`Unexpected mock SQL: ${normalized}`);
  }

  return {
    query,
    async getConnection() {
      return { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, query };
    },
    customers,
    sessions,
    tokens,
    jobs,
    queries,
    seedToken({ id, userId, type, token, expiresAt = new Date(Date.now() + 30 * 60 * 1000) }) {
      tokens.set(id, { id, user_id: userId, token_type: type, token_hash: hashToken(token).toString('hex'), expires_at: expiresAt, consumed_at: null });
    },
  };
}

async function makeApp(pool, { allowedOrigins = [ORIGIN], publicOrigin = ORIGIN } = {}) {
  const app = express();
  app.use('/auth', await createAuthRouter({
    pool,
    allowedOrigins,
    publicOrigin,
    mail: {
      configured: true,
      sendVerification: async () => { throw new Error('SMTP must not be called by this route workflow test'); },
      sendPasswordReset: async () => { throw new Error('SMTP must not be called by this route workflow test'); },
    },
    sheets: { configured: false },
  }));
  return app;
}

function state(agent, csrfToken, cookie) {
  const headers = (request) => request
    .set('Origin', ORIGIN)
    .set('X-CSRF-Token', csrfToken)
    .set('Cookie', cookie)
    .set('Content-Type', 'application/json');
  return {
    post(path) {
      return headers(agent.post(path));
    },
    put(path) {
      return headers(agent.put(path));
    },
  };
}

test('isolated auth workflow covers register, verify, session rotation, logout, and reset cleanup', async () => {
  const pool = createStrictMockPool();
  const app = await makeApp(pool);
  const agent = request.agent(app);

  const csrf = await agent.get('/auth/csrf').set('Origin', ORIGIN);
  assert.equal(csrf.status, 200);
  assert.match(csrf.body.csrfToken, /^[a-f0-9]{64}$/u);
  const csrfToken = csrf.body.csrfToken;
  let cookie = csrf.headers['set-cookie'][0];
  const anonymousCookie = cookie;
  assert.match(anonymousCookie, /HttpOnly/iu);
  assert.match(anonymousCookie, /Secure/iu);
  assert.match(anonymousCookie, /SameSite=None/iu);

  const untrustedSignup = await request(app).post('/auth/register')
    .set('Origin', 'https://evil.example')
    .send({ name: NAME, email: EMAIL, password: OLD_PASSWORD, termsAccepted: true });
  assert.equal(untrustedSignup.status, 403);

  const registration = await request(app).post('/auth/register')
    .set('Origin', ORIGIN)
    .send({
    name: NAME,
    email: EMAIL,
    password: OLD_PASSWORD,
    termsAccepted: true,
    marketingConsent: false,
    });
  assert.equal(registration.status, 202, JSON.stringify(registration.body));
  assert.match(registration.body.message, /verification email/iu);
  assert.equal(pool.jobs.size, 1);
  const customer = [...pool.customers.values()][0];
  assert.ok(customer);
  assert.notEqual(customer.password_hash, OLD_PASSWORD);
  assert.match(customer.password_hash, /^\$argon2/);
  assert.equal(customer.verified_at, null);

  const duplicate = await state(agent, csrfToken, cookie).post('/auth/register').send({
    name: NAME, email: EMAIL, password: OLD_PASSWORD, termsAccepted: true,
  });
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.body.message, registration.body.message);
  assert.equal(pool.customers.size, 1);

  const beforeVerificationLogin = await state(agent, csrfToken, cookie).post('/auth/login').send({ email: EMAIL, password: OLD_PASSWORD });
  assert.equal(beforeVerificationLogin.status, 401);

  const verificationToken = 'a'.repeat(64);
  pool.seedToken({ id: 'verify-fixture', userId: customer.id, type: 'verify_email', token: verificationToken });
  const verified = await state(agent, csrfToken, cookie).post('/auth/verify-email').send({ token: verificationToken, password: OLD_PASSWORD });
  assert.equal(verified.status, 200);
  assert.ok(customer.verified_at);
  assert.equal(pool.tokens.get('verify-fixture').consumed_at instanceof Date, true);

  const repeatedVerification = await state(agent, csrfToken, cookie).post('/auth/verify-email').send({ token: verificationToken, password: OLD_PASSWORD });
  assert.equal(repeatedVerification.status, 400);

  const login = await state(agent, csrfToken, cookie).post('/auth/login').send({ email: EMAIL, password: OLD_PASSWORD });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.email, EMAIL);
  assert.equal(login.body.user.emailVerified, true);
  assert.equal(login.body.user.password_hash, undefined);
  assert.notEqual(login.headers['set-cookie'][0], anonymousCookie);
  assert.match(login.headers['set-cookie'][0], /__Host-silkit_session=/u);
  assert.match(login.headers['set-cookie'][0], /HttpOnly/iu);
  assert.match(login.headers['set-cookie'][0], /Secure/iu);
  assert.match(login.headers['set-cookie'][0], /SameSite=None/iu);
  assert.equal([...pool.sessions.values()].filter((session) => session.revoked_at).length, 1);

  cookie = login.headers['set-cookie'][0];
  const loggedInCsrf = await agent.get('/auth/csrf').set('Origin', ORIGIN).set('Cookie', cookie);
  assert.equal(loggedInCsrf.status, 200);
  const profile = await agent.get('/auth/me').set('Cookie', cookie);
  assert.equal(profile.status, 200);
  assert.equal(profile.body.user.email, EMAIL);
  assert.equal(Object.hasOwn(profile.body.user, 'password_hash'), false);

  const logout = await state(agent, loggedInCsrf.body.csrfToken, cookie).post('/auth/logout').send({});
  assert.equal(logout.status, 204);
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/iu);
  assert.equal([...pool.sessions.values()].filter((session) => session.revoked_at).length, 2);

  cookie = logout.headers['set-cookie'][0];
  const resetCsrf = await agent.get('/auth/csrf').set('Origin', ORIGIN).set('Cookie', cookie);
  cookie = resetCsrf.headers['set-cookie'][0];
  const loginAgain = await state(agent, resetCsrf.body.csrfToken, cookie).post('/auth/login').send({ email: EMAIL, password: OLD_PASSWORD });
  assert.equal(loginAgain.status, 200);
  cookie = loginAgain.headers['set-cookie'][0];
  const activeCsrf = await agent.get('/auth/csrf').set('Origin', ORIGIN).set('Cookie', cookie);
  const activeSession = [...pool.sessions.values()].find((session) => session.user_id === customer.id && !session.revoked_at);
  assert.ok(activeSession);

  pool.seedToken({ id: 'old-reset-fixture', userId: customer.id, type: 'password_reset', token: 'b'.repeat(64) });
  pool.seedToken({ id: 'old-verify-fixture', userId: customer.id, type: 'verify_email', token: 'c'.repeat(64) });
  pool.jobs.set('pending-reset-job', { id: 'pending-reset-job', user_id: customer.id, status: 'pending' });
  pool.jobs.set('processing-reset-job', { id: 'processing-reset-job', user_id: customer.id, status: 'processing' });

  const reset = await state(agent, activeCsrf.body.csrfToken, cookie).post('/auth/reset-password').send({
    token: 'b'.repeat(64),
    password: NEW_PASSWORD,
  });
  assert.equal(reset.status, 200);
  assert.equal([...pool.tokens.values()].filter((token) => token.user_id === customer.id && !token.consumed_at).length, 0);
  assert.equal([...pool.sessions.values()].filter((session) => session.user_id === customer.id && !session.revoked_at).length, 0);
  assert.equal(pool.jobs.get('pending-reset-job').status, 'cancelled');
  assert.equal(pool.jobs.get('processing-reset-job').status, 'cancelled');

  cookie = reset.headers['set-cookie']?.[0] || cookie;
  const postResetCsrf = await agent.get('/auth/csrf').set('Origin', ORIGIN).set('Cookie', cookie);
  cookie = postResetCsrf.headers['set-cookie'][0];
  const oldPasswordLogin = await state(agent, postResetCsrf.body.csrfToken, cookie).post('/auth/login').send({ email: EMAIL, password: OLD_PASSWORD });
  assert.equal(oldPasswordLogin.status, 401);
  const newPasswordLogin = await state(agent, postResetCsrf.body.csrfToken, cookie).post('/auth/login').send({ email: EMAIL, password: NEW_PASSWORD });
  assert.equal(newPasswordLogin.status, 200);
  assert.equal(newPasswordLogin.body.user.email, EMAIL);
});

test('local signups receive a verification link on the site origin, never a preview host', async () => {
  const productionOrigin = 'https://silkitelegantly.com';
  const loopbackOrigin = 'http://127.0.0.1:3000';
  const allowedOrigins = new Set([productionOrigin, loopbackOrigin]);
  // Without a request origin, links fall back to the production site origin.
  assert.equal(resolvePublicAppOrigin({ development: true, allowedOrigins }), productionOrigin);

  const pool = createStrictMockPool();
  const app = await makeApp(pool, { allowedOrigins, publicOrigin: productionOrigin });
  const registration = await request(app).post('/auth/register')
    .set('Origin', loopbackOrigin)
    .send({ name: 'Preview Test', email: 'preview-test@example.invalid', password: OLD_PASSWORD, termsAccepted: true });

  assert.equal(registration.status, 202, JSON.stringify(registration.body));
  assert.equal(pool.jobs.size, 1);
  assert.equal([...pool.jobs.values()][0].origin, loopbackOrigin);
});

test('account self-service covers profile edits, address save and clear, and session-rotating password change', async () => {
  const pool = createStrictMockPool();
  const app = await makeApp(pool);
  const agent = request.agent(app);

  async function createVerifiedCustomer(email, password) {
    await request(app).post('/auth/register')
      .set('Origin', ORIGIN)
      .send({ name: NAME, email, password, termsAccepted: true });
    const customer = [...pool.customers.values()].find((entry) => entry.email === email);
    const verifyToken = `${Buffer.from(email).toString('hex')}${'0'.repeat(64)}`.slice(0, 64);
    pool.seedToken({ id: `verify-${email}`, userId: customer.id, type: 'verify_email', token: verifyToken });
    const csrf = await agent.get('/auth/csrf').set('Origin', ORIGIN);
    const verified = await state(agent, csrf.body.csrfToken, csrf.headers['set-cookie'][0]).post('/auth/verify-email')
      .send({ token: verifyToken, password });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    return customer;
  }

  const account = await createVerifiedCustomer(EMAIL, OLD_PASSWORD);
  // Login itself rides on the anonymous session + CSRF token issued by /auth/csrf.
  const preAuth = await agent.get('/auth/csrf').set('Origin', ORIGIN);
  const login = await state(agent, preAuth.body.csrfToken, preAuth.headers['set-cookie'][0])
    .post('/auth/login').send({ email: EMAIL, password: OLD_PASSWORD });
  assert.equal(login.status, 200);
  let cookie = login.headers['set-cookie'][0];
  const csrf = await agent.get('/auth/csrf').set('Origin', ORIGIN).set('Cookie', cookie);
  const csrfToken = csrf.body.csrfToken;
  const put = (path) => state(agent, csrfToken, cookie).put(path);

  // Name-only save keeps the email and re-enqueues sheet sync via the pending variant.
  const nameSave = await put('/auth/profile').send({
    name: 'Renamed', email: EMAIL, phone: '+22245294511', marketingConsent: true,
  });
  assert.equal(nameSave.status, 200, JSON.stringify(nameSave.body));
  assert.equal(nameSave.body.user.name, 'Renamed');
  assert.equal(nameSave.body.user.phone, '+22245294511');
  assert.equal(nameSave.body.user.marketingConsent, true);
  assert.equal(nameSave.body.user.addressLine1, null);
  assert.equal([...pool.customers.values()][0].sheet_sync_status, 'pending');

  // Missing required consent / invalid body → 400.
  const invalidBody = await put('/auth/profile').send({ name: NAME, email: EMAIL, phone: null });
  assert.equal(invalidBody.status, 400);
  assert.equal(invalidBody.body.error, 'invalid_profile');

  // Email change without a current password is refused.
  const emailNoPassword = await put('/auth/profile').send({
    name: 'Renamed', email: 'moved@example.invalid', phone: null, marketingConsent: true,
  });
  assert.equal(emailNoPassword.status, 401);

  // Email change with the wrong current password is refused.
  const emailWrongPassword = await put('/auth/profile').send({
    name: 'Renamed', email: 'moved@example.invalid', phone: null, marketingConsent: true, currentPassword: 'wrong-password-phrase',
  });
  assert.equal(emailWrongPassword.status, 401);

  const other = await createVerifiedCustomer('other@example.invalid', OLD_PASSWORD);
  const emailCollision = await put('/auth/profile').send({
    name: 'Renamed', email: 'other@example.invalid', phone: null, marketingConsent: true,
    currentPassword: OLD_PASSWORD,
  });
  assert.equal(emailCollision.status, 409);
  assert.equal(emailCollision.body.error, 'email_taken');

  // Successful email change confirms the stored password and re-enqueues the sheet.
  const emailChange = await put('/auth/profile').send({
    name: 'Renamed', email: 'moved@example.invalid', phone: null, marketingConsent: true,
    currentPassword: OLD_PASSWORD,
  });
  assert.equal(emailChange.status, 200, JSON.stringify(emailChange.body));
  assert.equal(emailChange.body.user.email, 'moved@example.invalid');
  assert.equal([...pool.customers.values()].find((entry) => entry.id === account.id).email, 'moved@example.invalid');

  // Address save → present on the profile; empty payload clears it.
  const addressSave = await put('/auth/address').send({
    addressLine1: '12 Silk Road', addressLine2: '', city: 'Nouakchott', postalCode: '0000', country: 'MR',
  });
  assert.equal(addressSave.status, 200, JSON.stringify(addressSave.body));
  assert.equal(addressSave.body.user.addressLine1, '12 Silk Road');
  assert.equal(addressSave.body.user.city, 'Nouakchott');
  assert.equal(addressSave.body.user.country, 'MR');

  const addressInvalid = await put('/auth/address').send({
    addressLine1: '12 Silk Road', addressLine2: '', city: 'Nouakchott', postalCode: '0000', country: 'ZZ',
  });
  assert.equal(addressInvalid.status, 400);

  const addressIncomplete = await put('/auth/address').send({
    addressLine1: '12 Silk Road', addressLine2: '', city: '', postalCode: '', country: '',
  });
  assert.equal(addressIncomplete.status, 400);

  const addressClear = await put('/auth/address').send({
    addressLine1: '', addressLine2: '', city: '', postalCode: '', country: '',
  });
  assert.equal(addressClear.status, 200);
  assert.equal(addressClear.body.user.addressLine1, null);
  assert.equal(addressClear.body.user.postalCode, null);

  // Password change: wrong current → 401; weak new → 400; correct → rotation.
  const wrongCurrent = await state(agent, csrfToken, cookie).post('/auth/change-password').send({
    currentPassword: 'nope-not-the-password',
    password: 'Sable!Quartz11Fern#Echo',
  });
  assert.equal(wrongCurrent.status, 401);

  const weakPassword = await state(agent, csrfToken, cookie).post('/auth/change-password').send({
    currentPassword: OLD_PASSWORD,
    password: 'aaaaaaaaaaaaaaa',
  });
  assert.equal(weakPassword.status, 400);
  assert.equal(weakPassword.body.error, 'invalid_password');

  const oldCookie = cookie;
  const change = await state(agent, csrfToken, cookie).post('/auth/change-password').send({
    currentPassword: OLD_PASSWORD,
    password: 'Sable!Quartz11Fern#Echo',
  });
  assert.equal(change.status, 200, JSON.stringify(change.body));
  assert.match(change.body.message, /password/iu);
  assert.equal([...pool.sessions.values()].filter((session) => session.user_id === account.id && !session.revoked_at).length, 1);
  cookie = change.headers['set-cookie'][0];
  assert.notEqual(cookie, oldCookie);

  // The fresh cookie keeps the device signed in; the old one is revoked.
  const refreshedCsrf = await agent.get('/auth/csrf').set('Origin', ORIGIN).set('Cookie', cookie);
  assert.equal(refreshedCsrf.status, 200);
  const freshProfile = await agent.get('/auth/me').set('Cookie', cookie);
  assert.equal(freshProfile.status, 200);
  assert.equal(freshProfile.body.user.email, 'moved@example.invalid');
  const staleProfile = await agent.get('/auth/me').set('Cookie', oldCookie);
  assert.equal(staleProfile.body.user, null);
});
