import express from 'express';
import crypto from 'node:crypto';
import {
  ANONYMOUS_SESSION_ABSOLUTE_MS,
  MAX_JSON_BYTES,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_COOKIE_NAME,
  DEV_SESSION_COOKIE_NAME,
  clientAddress,
  clearSessionCookie,
  hashToken,
  isAllowedOrigin,
  isJsonRequest,
  normalizeEmail,
  publicUser,
  randomToken,
  readSessionCookie,
  requestOrigin,
  setSecurityHeaders,
  setSessionCookie,
  timingSafeEqualBuffers,
  validateCountry,
  validateName,
  validateOptionalAddressLine,
  validatePhone,
  validBodyObject,
} from './security.js';
import { hashPassword, validatePassword, verifyPassword } from './passwords.js';
import { enqueueAccountEmail } from './mail-queue.js';

const GENERIC_REGISTER_MESSAGE = 'If registration is available, we will send a verification email to the address provided.';
const GENERIC_RECOVERY_MESSAGE = 'If an account matches that address, we will send instructions shortly.';
const GENERIC_LOGIN_MESSAGE = 'The email or password is incorrect.';
const GENERIC_VERIFY_MESSAGE = 'The verification request could not be completed.';
const TOKEN_PATTERN = /^[a-f0-9]{64}$/u;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMITS = {
  ip: 30,
  csrf: 20,
  email: 10,
  register: 8,
  recovery: 8,
};
const SYNC_RETRY_COOLDOWN_MS = 60 * 1000;

function now() {
  return new Date();
}

function dateAfter(milliseconds) {
  return new Date(Date.now() + milliseconds);
}

function isDuplicate(error) {
  return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;
}

async function transaction(pool, work) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch { /* preserve original error */ }
    throw error;
  } finally {
    connection.release();
  }
}

async function queryOne(pool, sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows[0] || null;
}

async function loadSession(pool, req, cookieName = SESSION_COOKIE_NAME) {
  const rawToken = readSessionCookie(req, cookieName);
  if (!rawToken) return null;
  const row = await queryOne(pool, `
    SELECT s.*, c.id AS customer_id, c.email, c.name, c.phone,
           c.marketing_consent, c.verified_at, c.created_at,
           c.sheet_sync_status, c.sheet_sync_error
      FROM auth_sessions s
      LEFT JOIN customers c ON c.id = s.user_id AND c.verified_at IS NOT NULL
     WHERE s.token_hash = ?
       AND s.revoked_at IS NULL
       AND UTC_TIMESTAMP(3) < s.idle_expires_at
       AND UTC_TIMESTAMP(3) < s.absolute_expires_at
     LIMIT 1`, [hashToken(rawToken)]);
  if (!row) return null;
  const customer = row.customer_id ? {
    id: row.customer_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    marketing_consent: row.marketing_consent,
    verified_at: row.verified_at,
    created_at: row.created_at,
    sheet_sync_status: row.sheet_sync_status,
    sheet_sync_error: row.sheet_sync_error,
  } : null;
  await pool.query(`
    UPDATE auth_sessions
       SET last_seen_at = UTC_TIMESTAMP(3),
           idle_expires_at = LEAST(DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 MINUTE), absolute_expires_at)
     WHERE id = ? AND revoked_at IS NULL`, [row.id]);
  return { ...row, customer, rawToken };
}

async function createSession(pool, { userId = null, anonymous = false } = {}) {
  const rawToken = randomToken(32);
  const csrfToken = randomToken(32);
  const createdAt = now();
  return transaction(pool, async (connection) => {
    const [result] = await connection.query(`
      INSERT INTO auth_sessions
        (id, token_hash, csrf_token, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
      crypto.randomUUID(),
      hashToken(rawToken),
      csrfToken,
      userId,
      createdAt,
      createdAt,
      dateAfter(SESSION_IDLE_MS),
      dateAfter(anonymous ? ANONYMOUS_SESSION_ABSOLUTE_MS : SESSION_ABSOLUTE_MS),
    ]);
    return { id: result.insertId || null, rawToken, csrfToken };
  });
}

async function createSessionForLogin(pool, session, user) {
  const rawToken = randomToken(32);
  const csrfToken = randomToken(32);
  const createdAt = now();
  return transaction(pool, async (connection) => {
    const [rows] = await connection.query(
      'SELECT id, password_hash, verified_at FROM customers WHERE id = ? LIMIT 1 FOR UPDATE',
      [user.id],
    );
    const current = rows[0];
    if (!current || current.password_hash !== user.password_hash || !current.verified_at) return null;
    if (session?.id) {
      await connection.query(
        'UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE id = ? AND revoked_at IS NULL',
        [session.id],
      );
    }
    await connection.query(`
      INSERT INTO auth_sessions
        (id, token_hash, csrf_token, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
      crypto.randomUUID(), hashToken(rawToken), csrfToken, user.id, createdAt, createdAt,
      dateAfter(SESSION_IDLE_MS), dateAfter(SESSION_ABSOLUTE_MS),
    ]);
    return { rawToken, csrfToken };
  });
}

async function revokeSession(pool, session) {
  if (!session?.id) return;
  await pool.query('UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE id = ? AND revoked_at IS NULL', [session.id]);
}

async function revokeUserSessions(pool, userId) {
  await pool.query('UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL', [userId]);
}

function csrfMatches(session, provided) {
  if (!session || typeof provided !== 'string' || !TOKEN_PATTERN.test(provided) || typeof session.csrf_token !== 'string') return false;
  return timingSafeEqualBuffers(Buffer.from(session.csrf_token, 'utf8'), Buffer.from(provided, 'utf8'));
}

async function stateSession(pool, req, cookieName = SESSION_COOKIE_NAME) {
  const origin = requestOrigin(req);
  if (!isAllowedOrigin(origin, req.authAllowedOrigins)) return { error: 'origin' };
  if (!isJsonRequest(req)) return { error: 'content_type' };
  const session = await loadSession(pool, req, cookieName);
  if (!session) return { error: 'session' };
  const csrf = req.headers['x-csrf-token'];
  if (!csrfMatches(session, csrf)) return { error: 'csrf' };
  return { session };
}

function rejectState(res, error) {
  if (error === 'content_type') return res.status(415).json({ error: 'json_required' });
  return res.status(403).json({ error: 'request_not_authorized' });
}

async function allowRate(pool, bucketKey, limit) {
  const current = Date.now();
  return transaction(pool, async (connection) => {
    await connection.query('INSERT IGNORE INTO auth_rate_limits (bucket_key, window_started_at, attempts, blocked_until) VALUES (?, UTC_TIMESTAMP(3), 0, NULL)', [bucketKey]);
    const row = (await connection.query('SELECT * FROM auth_rate_limits WHERE bucket_key = ? FOR UPDATE', [bucketKey]))[0][0];
    if (!row) throw new Error('rate_limit_row_missing');
    const started = new Date(row.window_started_at).getTime();
    const blocked = row.blocked_until && new Date(row.blocked_until).getTime() > current;
    if (blocked) return false;
    if (!Number.isFinite(started) || current - started >= RATE_WINDOW_MS) {
      await connection.query('UPDATE auth_rate_limits SET window_started_at = UTC_TIMESTAMP(3), attempts = 1, blocked_until = NULL WHERE bucket_key = ?', [bucketKey]);
      return true;
    }
    const attempts = Number(row.attempts || 0) + 1;
    const over = attempts > limit;
    await connection.query('UPDATE auth_rate_limits SET attempts = ?, blocked_until = ? WHERE bucket_key = ?', [attempts, over ? dateAfter(RATE_WINDOW_MS) : null, bucketKey]);
    return !over;
  });
}

async function rateRequest(pool, req, email, kind) {
  const ipLimit = kind === 'csrf' ? RATE_LIMITS.csrf : RATE_LIMITS.ip;
  const ipBucket = `rate:${kind}:ip:${hashToken(clientAddress(req)).toString('hex')}`;
  const ipOk = await allowRate(pool, ipBucket, ipLimit);
  if (!ipOk) return false;
  if (email) {
    const emailBucket = `rate:${kind}:email:${hashToken(email).toString('hex')}`;
    const emailOk = await allowRate(pool, emailBucket, RATE_LIMITS.email);
    if (!emailOk) return false;
  }
  return true;
}

// Email links must point at a site origin we control. Production only trusts
// https; development also trusts loopback http so local signups get local
// links. Both are gated by the allowed-origins set, which never includes
// loopback outside development.
function trustedLinkOrigin(value, origins) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    const loopbackDev = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
    if ((url.protocol !== 'https:' && !loopbackDev) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return isAllowedOrigin(url.origin, origins) ? url.origin : null;
  } catch {
    return null;
  }
}

function requestOriginAllowed(req, origins) {
  const headers = req?.headers || {};
  if (Object.prototype.hasOwnProperty.call(headers, 'origin')) return isAllowedOrigin(requestOrigin(req), origins);
  const fetchSite = headers['sec-fetch-site'];
  return typeof fetchSite === 'string' && fetchSite.toLowerCase() === 'same-origin';
}

async function findCustomerById(pool, id) {
  return queryOne(pool, 'SELECT * FROM customers WHERE id = ? LIMIT 1', [id]);
}

async function syncIfDue(pool, sheets, userId) {
  if (!sheets?.configured || typeof sheets.syncCustomer !== 'function') return;
  const row = await findCustomerById(pool, userId);
  if (!row || !row.verified_at || !['pending', 'failed'].includes(row.sheet_sync_status)) return;
  if (row.sheet_sync_attempted_at && Date.now() - new Date(row.sheet_sync_attempted_at).getTime() < SYNC_RETRY_COOLDOWN_MS) return;
  await pool.query(`UPDATE customers SET sheet_sync_attempted_at = UTC_TIMESTAMP(3) WHERE id = ?`, [userId]);
  try {
    await sheets.syncCustomer(userId);
    await pool.query(`UPDATE customers SET sheet_sync_status = 'synced', sheet_sync_error = NULL WHERE id = ?`, [userId]);
  } catch {
    // Keep the failure generic and never turn sheet availability into an auth decision.
    await pool.query(`UPDATE customers SET sheet_sync_status = 'failed', sheet_sync_error = 'SYNC_FAILED' WHERE id = ?`, [userId]);
  }
}

async function customerPublic(pool, sheets, userId) {
  await syncIfDue(pool, sheets, userId);
  return publicUser(await findCustomerById(pool, userId));
}

function validateRegistrationBody(body) {
  if (!validBodyObject(body)) return { error: 'invalid' };
  const name = validateName(body.name);
  const email = normalizeEmail(body.email);
  const phone = validatePhone(body.phone);
  if (!name || !email || phone === undefined || typeof body.password !== 'string' || body.termsAccepted !== true) return { error: 'invalid' };
  const marketingConsent = body.marketingConsent === true;
  const password = validatePassword(body.password, [name, email]);
  if (!password.ok) return { error: 'password', password };
  return { name, email, phone, marketingConsent, password: password.normalized };
}

function validateNewPassword(body, user) {
  if (!validBodyObject(body) || typeof body.password !== 'string') return null;
  const result = validatePassword(body.password, [user?.name, user?.email]);
  return result.ok ? result.normalized : null;
}

export async function createAuthRouter({ pool, mail = {}, sheets = {}, allowedOrigins = new Set(), publicOrigin = null } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.getConnection !== 'function') throw new TypeError('pool is required');
  const dummyPasswordHash = await hashPassword('silkit invalid login work factor passphrase');
  const router = express.Router();
  const origins = new Set();
  const configuredOrigins = allowedOrigins instanceof Set || Array.isArray(allowedOrigins) ? allowedOrigins : [];
  for (const origin of configuredOrigins) {
    if (typeof origin !== 'string') continue;
    try { origins.add(new URL(origin).origin); } catch { /* ignore malformed configuration */ }
  }
  // Only development configs include loopback http origins, so their presence
  // means we must issue a browser-acceptable cookie. Production never matches.
  const secureSessionCookies = ![...origins].some((origin) => {
    try {
      const url = new URL(origin);
      return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
    } catch { return false; }
  });
  const sessionCookie = secureSessionCookies
    ? { name: SESSION_COOKIE_NAME, secure: true }
    : { name: DEV_SESSION_COOKIE_NAME, secure: false };
  const publicEmailOrigin = trustedLinkOrigin(publicOrigin, origins);
  const emailOriginFor = (req) => trustedLinkOrigin(requestOrigin(req), origins) || publicEmailOrigin;
  router.use((req, res, next) => {
    req.authAllowedOrigins = origins;
    setSecurityHeaders(res);
    next();
  });
  router.use(express.json({ limit: MAX_JSON_BYTES, type: 'application/json' }));

  router.get('/status', (req, res) => {
    res.json({ signupAvailable: Boolean(mail.configured), emailConfigured: Boolean(mail.configured), sheetsConfigured: Boolean(sheets.configured) });
  });

  router.get('/csrf', async (req, res, next) => {
    try {
      if (!requestOriginAllowed(req, origins)) return res.status(403).json({ error: 'request_not_authorized' });
      let session = await loadSession(pool, req, sessionCookie.name);
      if (!session) {
        if (!await rateRequest(pool, req, null, 'csrf')) return res.status(429).json({ error: 'try_again_later' });
        const created = await createSession(pool, { anonymous: true });
        setSessionCookie(res, created.rawToken, Math.floor(ANONYMOUS_SESSION_ABSOLUTE_MS / 1000), { secure: sessionCookie.secure });
        session = { csrf_token: created.csrfToken };
      }
      res.json({ csrfToken: session.csrf_token });
    } catch (error) { next(error); }
  });

  router.get('/me', async (req, res, next) => {
    try {
      const session = await loadSession(pool, req, sessionCookie.name);
      const user = session?.customer ? await customerPublic(pool, sheets, session.customer.id) : null;
      res.json({ user });
    } catch (error) { next(error); }
  });

  router.post('/register', async (req, res, next) => {
    try {
      if (!requestOriginAllowed(req, origins)) return rejectState(res, 'origin');
      if (!isJsonRequest(req)) return rejectState(res, 'content_type');
      if (!mail.configured) return res.status(503).json({ error: 'email_unavailable' });
      const registration = validateRegistrationBody(req.body);
      const email = normalizeEmail(req.body?.email) || 'invalid';
      if (!await rateRequest(pool, req, email, 'register')) return res.status(429).json({ error: 'try_again_later' });
      if (req.body?.website) return res.status(202).json({ message: GENERIC_REGISTER_MESSAGE });
      if (registration.error) return res.status(400).json({ error: 'invalid_registration' });
      const origin = emailOriginFor(req);
      if (!origin) return res.status(503).json({ error: 'email_unavailable' });

      const passwordHash = await hashPassword(registration.password);
      const userId = crypto.randomUUID();
      try {
        await transaction(pool, async (connection) => {
          const [existing] = await connection.query('SELECT id FROM customers WHERE email = ? LIMIT 1 FOR UPDATE', [registration.email]);
          if (existing.length) return;
          await connection.query(`
            INSERT INTO customers
              (id, email, name, phone, password_hash, marketing_consent, created_at, sheet_sync_status)
            VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), 'pending')`, [
            userId, registration.email, registration.name, registration.phone, passwordHash, registration.marketingConsent ? 1 : 0,
          ]);
          await enqueueAccountEmail(connection, { userId, type: 'verify_email', origin });
        });
      } catch (error) {
        if (isDuplicate(error)) return res.status(202).json({ message: GENERIC_REGISTER_MESSAGE });
        throw error;
      }
      return res.status(202).json({ message: GENERIC_REGISTER_MESSAGE });
    } catch (error) { next(error); }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const state = await stateSession(pool, req, sessionCookie.name);
      if (state.error) return rejectState(res, state.error);
      const email = normalizeEmail(req.body?.email) || 'invalid';
      if (!await rateRequest(pool, req, email, 'login')) return res.status(429).json({ error: 'try_again_later' });
      const suppliedPassword = typeof req.body?.password === 'string' ? req.body.password : '';
      const user = await queryOne(pool, 'SELECT * FROM customers WHERE email = ? LIMIT 1', [email]);
      // Always perform Argon2 verification, including for nonexistent addresses.
      const hash = user?.password_hash || dummyPasswordHash;
      const passwordOk = await verifyPassword(suppliedPassword, hash);
      if (!user || !passwordOk || !user.verified_at) return res.status(401).json({ error: GENERIC_LOGIN_MESSAGE });

      const session = await createSessionForLogin(pool, state.session, user);
      if (!session) return res.status(401).json({ error: GENERIC_LOGIN_MESSAGE });
      setSessionCookie(res, session.rawToken, undefined, { secure: sessionCookie.secure });
      const publicProfile = await customerPublic(pool, sheets, user.id);
      return res.json({ user: publicProfile });
    } catch (error) { next(error); }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      const state = await stateSession(pool, req, sessionCookie.name);
      if (state.error) return rejectState(res, state.error);
      await revokeSession(pool, state.session);
      clearSessionCookie(res, { secure: sessionCookie.secure });
      res.status(204).end();
    } catch (error) { next(error); }
  });

  router.put('/profile', async (req, res, next) => {
    try {
      const state = await stateSession(pool, req, sessionCookie.name);
      if (state.error) return rejectState(res, state.error);
      const userId = state.session.customer?.id;
      if (!userId) return res.status(401).json({ error: 'invalid_credentials' });
      if (!validBodyObject(req.body)) return res.status(400).json({ error: 'invalid_profile' });
      if (!await rateRequest(pool, req, null, 'profile')) return res.status(429).json({ error: 'try_again_later' });

      const name = validateName(req.body.name);
      const email = normalizeEmail(req.body.email);
      const phone = validatePhone(req.body.phone);
      if (!name || !email || phone === undefined || typeof req.body.marketingConsent !== 'boolean') {
        return res.status(400).json({ error: 'invalid_profile' });
      }
      const user = await findCustomerById(pool, userId);
      if (!user) return res.status(401).json({ error: 'invalid_credentials' });
      const emailChanged = email !== user.email;
      if (emailChanged) {
        const currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
        const passwordOk = currentPassword && await verifyPassword(currentPassword, user.password_hash || dummyPasswordHash);
        if (!passwordOk) return res.status(401).json({ error: 'invalid_credentials' });
      }
      const marketingConsent = req.body.marketingConsent;
      const sheetRelevantChanged = emailChanged
        || name !== user.name
        || phone !== (user.phone ?? null)
        || marketingConsent !== Boolean(user.marketing_consent);

      try {
        await transaction(pool, async (connection) => {
          if (sheetRelevantChanged) {
            await connection.query(
              "UPDATE customers SET name = ?, phone = ?, email = ?, marketing_consent = ?, sheet_sync_status = 'pending' WHERE id = ?",
              [name, phone, email, marketingConsent ? 1 : 0, userId],
            );
          } else {
            await connection.query(
              'UPDATE customers SET name = ?, phone = ?, email = ?, marketing_consent = ? WHERE id = ?',
              [name, phone, email, marketingConsent ? 1 : 0, userId],
            );
          }
        });
      } catch (error) {
        if (isDuplicate(error)) return res.status(409).json({ error: 'email_taken' });
        throw error;
      }
      // customerPublic triggers syncIfDue, so a re-enqueued row is tried in-request.
      return res.json({ user: await customerPublic(pool, sheets, userId) });
    } catch (error) { next(error); }
  });

  router.put('/address', async (req, res, next) => {
    try {
      const state = await stateSession(pool, req, sessionCookie.name);
      if (state.error) return rejectState(res, state.error);
      const userId = state.session.customer?.id;
      if (!userId) return res.status(401).json({ error: 'invalid_credentials' });
      if (!validBodyObject(req.body)) return res.status(400).json({ error: 'invalid_profile' });
      if (!await rateRequest(pool, req, null, 'address')) return res.status(429).json({ error: 'try_again_later' });

      const line1 = validateOptionalAddressLine(req.body.addressLine1);
      const line2 = validateOptionalAddressLine(req.body.addressLine2);
      const city = validateOptionalAddressLine(req.body.city, 120);
      const postalCode = validateOptionalAddressLine(req.body.postalCode, 20);
      const countryInput = req.body.country;
      const country = countryInput === undefined || countryInput === null || (typeof countryInput === 'string' && !countryInput.trim())
        ? null
        : validateCountry(countryInput);
      if (line1 === undefined || line2 === undefined || city === undefined || postalCode === undefined || country === undefined) {
        return res.status(400).json({ error: 'invalid_profile' });
      }
      const clearing = line1 === null && line2 === null && city === null && postalCode === null && country === null;
      if (!clearing && (line1 === null || city === null || postalCode === null || country === null)) {
        return res.status(400).json({ error: 'invalid_profile' });
      }

      await pool.query(
        'UPDATE customers SET address_line1 = ?, address_line2 = ?, city = ?, postal_code = ?, country = ? WHERE id = ?',
        [line1, line2, city, postalCode, country, userId],
      );
      return res.json({ user: await customerPublic(pool, sheets, userId) });
    } catch (error) { next(error); }
  });

  router.post('/change-password', async (req, res, next) => {
    try {
      const state = await stateSession(pool, req, sessionCookie.name);
      if (state.error) return rejectState(res, state.error);
      const userId = state.session.customer?.id;
      if (!userId) return res.status(401).json({ error: 'invalid_credentials' });
      if (!validBodyObject(req.body) || typeof req.body.currentPassword !== 'string' || !req.body.currentPassword) {
        return res.status(400).json({ error: 'invalid_password' });
      }
      if (!await rateRequest(pool, req, null, 'password')) return res.status(429).json({ error: 'try_again_later' });
      const user = await queryOne(pool, 'SELECT * FROM customers WHERE id = ? LIMIT 1', [userId]);
      const suppliedCurrent = req.body.currentPassword;
      // Always perform Argon2 verification, including for nonexistent accounts.
      const passwordOk = await verifyPassword(suppliedCurrent, user?.password_hash || dummyPasswordHash);
      if (!user || !passwordOk) return res.status(401).json({ error: 'invalid_credentials' });
      const password = validateNewPassword(req.body, user);
      // Cheap no-op guard: refuse setting the same literal password.
      if (!password || password === suppliedCurrent) return res.status(400).json({ error: 'invalid_password' });
      const passwordHash = await hashPassword(password);

      const session = await transaction(pool, async (connection) => {
        const [customers] = await connection.query(
          'SELECT id, password_hash, verified_at FROM customers WHERE id = ? LIMIT 1 FOR UPDATE',
          [userId],
        );
        const current = customers[0];
        if (!current || current.password_hash !== user.password_hash || !current.verified_at) return null;
        await connection.query('UPDATE customers SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
        await connection.query('UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL', [userId]);
        await connection.query(`
          UPDATE auth_mail_jobs
             SET status = 'cancelled', completed_at = UTC_TIMESTAMP(3), claimed_at = NULL, safe_error_code = 'PASSWORD_CHANGED'
           WHERE user_id = ? AND status IN ('pending', 'processing')`, [userId]);
        const rawToken = randomToken(32);
        const csrfToken = randomToken(32);
        const createdAt = now();
        await connection.query(`
          INSERT INTO auth_sessions
            (id, token_hash, csrf_token, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
          crypto.randomUUID(), hashToken(rawToken), csrfToken, userId, createdAt, createdAt,
          dateAfter(SESSION_IDLE_MS), dateAfter(SESSION_ABSOLUTE_MS),
        ]);
        return { rawToken, csrfToken };
      });
      if (!session) return res.status(401).json({ error: 'invalid_credentials' });
      setSessionCookie(res, session.rawToken, undefined, { secure: sessionCookie.secure });
      return res.json({ message: 'Your password has been changed.' });
    } catch (error) { next(error); }
  });

  router.post('/verify-email', async (req, res, next) => {
    try {
      const state = await stateSession(pool, req, sessionCookie.name);
      if (state.error) return rejectState(res, state.error);
      if (!validBodyObject(req.body) || typeof req.body.token !== 'string' || !TOKEN_PATTERN.test(req.body.token) || typeof req.body.password !== 'string') return res.status(400).json({ error: 'invalid_verification' });
      if (!await rateRequest(pool, req, null, 'verify')) return res.status(429).json({ error: 'try_again_later' });
      const tokenHash = hashToken(req.body.token);
      const result = await transaction(pool, async (connection) => {
        const [owners] = await connection.query(`
          SELECT t.user_id FROM auth_tokens t
           WHERE t.token_hash = ? AND t.token_type = ? LIMIT 1`, [tokenHash, 'verify_email']);
        const owner = owners[0];
        if (!owner) return null;
        const [customers] = await connection.query(
          'SELECT id, password_hash, verified_at FROM customers WHERE id = ? LIMIT 1 FOR UPDATE',
          [owner.user_id],
        );
        const customer = customers[0];
        if (!customer) return null;
        const [rows] = await connection.query(`
          SELECT id AS token_id, user_id, expires_at, consumed_at
            FROM auth_tokens
           WHERE token_hash = ? AND token_type = ? AND user_id = ? LIMIT 1 FOR UPDATE`, [tokenHash, 'verify_email', customer.id]);
        const token = rows[0];
        if (!token || token.consumed_at || new Date(token.expires_at).getTime() <= Date.now()) return null;
        if (!await verifyPassword(req.body.password, customer.password_hash)) return null;
        await connection.query('UPDATE customers SET verified_at = COALESCE(verified_at, UTC_TIMESTAMP(3)) WHERE id = ?', [token.user_id]);
        await connection.query('UPDATE auth_tokens SET consumed_at = UTC_TIMESTAMP(3) WHERE id = ? AND consumed_at IS NULL', [token.token_id]);
        return token.user_id;
      });
      if (!result) return res.status(400).json({ error: GENERIC_VERIFY_MESSAGE });
      await syncIfDue(pool, sheets, result);
      return res.json({ message: 'Email verified. You can now sign in.' });
    } catch (error) { next(error); }
  });

  router.post('/resend-verification', async (req, res, next) => {
    try {
      const state = await stateSession(pool, req, sessionCookie.name);
      if (state.error) return rejectState(res, state.error);
      if (!mail.configured) return res.status(503).json({ error: 'email_unavailable' });
      const origin = emailOriginFor(req);
      if (!origin) return res.status(503).json({ error: 'email_unavailable' });
      const email = normalizeEmail(req.body?.email) || 'invalid';
      if (!await rateRequest(pool, req, email, 'resend')) return res.status(429).json({ error: 'try_again_later' });
      const user = await queryOne(pool, 'SELECT * FROM customers WHERE email = ? LIMIT 1', [email]);
      if (user && !user.verified_at) {
        await enqueueAccountEmail(pool, { userId: user.id, type: 'verify_email', origin });
      }
      return res.status(202).json({ message: GENERIC_REGISTER_MESSAGE });
    } catch (error) { next(error); }
  });

  router.post('/forgot-password', async (req, res, next) => {
    try {
      const state = await stateSession(pool, req, sessionCookie.name);
      if (state.error) return rejectState(res, state.error);
      if (!mail.configured) return res.status(503).json({ error: 'email_unavailable' });
      const origin = emailOriginFor(req);
      if (!origin) return res.status(503).json({ error: 'email_unavailable' });
      const email = normalizeEmail(req.body?.email) || 'invalid';
      if (!await rateRequest(pool, req, email, 'recovery')) return res.status(429).json({ message: GENERIC_RECOVERY_MESSAGE });
      const user = await queryOne(pool, 'SELECT * FROM customers WHERE email = ? LIMIT 1', [email]);
      if (user) {
        await enqueueAccountEmail(pool, { userId: user.id, type: 'password_reset', origin });
      }
      return res.status(202).json({ message: GENERIC_RECOVERY_MESSAGE });
    } catch (error) { next(error); }
  });

  router.post('/reset-password', async (req, res, next) => {
    try {
      const state = await stateSession(pool, req, sessionCookie.name);
      if (state.error) return rejectState(res, state.error);
      if (!validBodyObject(req.body) || typeof req.body.token !== 'string' || !TOKEN_PATTERN.test(req.body.token)) return res.status(400).json({ error: 'invalid_reset' });
      if (!await rateRequest(pool, req, null, 'reset')) return res.status(429).json({ error: 'try_again_later' });
      const tokenHash = hashToken(req.body.token);
      const owner = await queryOne(pool, `
        SELECT c.id, c.name, c.email FROM auth_tokens t JOIN customers c ON c.id = t.user_id
         WHERE t.token_hash = ? AND t.token_type = ? AND t.consumed_at IS NULL
           AND t.expires_at > UTC_TIMESTAMP(3) LIMIT 1`, [tokenHash, 'password_reset']);
      const password = validateNewPassword(req.body, owner);
      if (!owner || !password) return res.status(400).json({ error: 'invalid_reset' });
      const passwordHash = await hashPassword(password);
      const completed = await transaction(pool, async (connection) => {
        const [customers] = await connection.query(
          'SELECT id, email, name FROM customers WHERE id = ? LIMIT 1 FOR UPDATE',
          [owner.id],
        );
        if (!customers.length) return false;
        const [tokens] = await connection.query(`
          SELECT id, user_id, expires_at, consumed_at FROM auth_tokens
           WHERE token_hash = ? AND token_type = ? LIMIT 1 FOR UPDATE`, [tokenHash, 'password_reset']);
        const token = tokens[0];
        if (!token || token.user_id !== owner.id || token.consumed_at || new Date(token.expires_at).getTime() <= Date.now()) return false;
        await connection.query('UPDATE customers SET password_hash = ?, verified_at = COALESCE(verified_at, UTC_TIMESTAMP(3)) WHERE id = ?', [passwordHash, owner.id]);
        await connection.query(`
          UPDATE auth_tokens SET consumed_at = UTC_TIMESTAMP(3)
           WHERE user_id = ? AND consumed_at IS NULL`, [owner.id]);
        await connection.query('UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL', [owner.id]);
        await connection.query(`
          UPDATE auth_mail_jobs
             SET status = 'cancelled', completed_at = UTC_TIMESTAMP(3), claimed_at = NULL, safe_error_code = 'PASSWORD_RESET_COMPLETED'
           WHERE user_id = ? AND status IN ('pending', 'processing')`, [owner.id]);
        return true;
      });
      if (!completed) return res.status(400).json({ error: 'invalid_reset' });
      await syncIfDue(pool, sheets, owner.id);
      return res.json({ message: 'Password updated. You can now sign in.' });
    } catch (error) { next(error); }
  });

  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    if (error instanceof SyntaxError) return res.status(400).json({ error: 'invalid_json' });
    return res.status(500).json({ error: 'internal_error' });
  });

  return router;
}

export { GENERIC_LOGIN_MESSAGE, GENERIC_RECOVERY_MESSAGE, GENERIC_REGISTER_MESSAGE, csrfMatches, loadSession, validateRegistrationBody };
export default createAuthRouter;
