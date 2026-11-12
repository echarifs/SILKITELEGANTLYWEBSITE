import crypto from 'node:crypto';
import { normalizeCountryCode, normalizePhoneNumber } from '../shared/phone.js';

export const SESSION_COOKIE_NAME = '__Host-silkit_session';
export const DEV_SESSION_COOKIE_NAME = 'silkit_session';
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 24 * 60 * 60 * 1000;
export const ANONYMOUS_SESSION_ABSOLUTE_MS = 60 * 60 * 1000;
export const VERIFICATION_TOKEN_TTL_MS = 30 * 60 * 1000;
export const PASSWORD_RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
export const MAX_JSON_BYTES = 16 * 1024;

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest();
}

export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.normalize('NFC').trim().toLowerCase();
  if (!email || email.length > 254 || /[\u0000-\u001f\u007f\s]/u.test(email)) return null;
  // Accept one mailbox, not SMTP address-list/display-name/comment syntax.
  if (/[<>(),;:"\\\[\]]/u.test(email)) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1 || email.indexOf('@') !== at) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || domain.length > 253 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  if (!/^[^@]+@[^@]+$/u.test(email) || domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return null;
  return email;
}

export function validateName(value) {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFC').trim();
  const length = Array.from(name).length;
  if (length < 1 || length > 128 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(name)) return null;
  return name;
}

export function validatePhone(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const phone = value.normalize('NFC').trim();
  if (!phone) return null;
  return normalizePhoneNumber(phone) || undefined;
}

/** Optional address line: null clears it, undefined is invalid, a string is kept (limit in code points). */
export function validateOptionalAddressLine(value, maxLength = 200) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const line = value.normalize('NFC').trim();
  if (!line) return null;
  const length = Array.from(line).length;
  if (length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(line)) return undefined;
  return line;
}

/** ISO-2 country code from the shared known-country set, or undefined. */
export function validateCountry(value) {
  return normalizeCountryCode(value);
}

export function isAllowedOrigin(origin, allowedOrigins) {
  if (typeof origin !== 'string' || !origin) return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
  const candidate = parsed.origin;
  if (allowedOrigins instanceof Set) {
    return allowedOrigins.has(candidate);
  }
  if (Array.isArray(allowedOrigins)) return allowedOrigins.includes(candidate);
  return false;
}

export function requestOrigin(req) {
  const origin = req?.headers?.origin;
  return Array.isArray(origin) ? (origin.length === 1 ? origin[0] : undefined) : origin;
}

export function clientAddress(req) {
  return String(req?.ip || req?.socket?.remoteAddress || 'unknown').slice(0, 128);
}

export function safeErrorCode(error, fallback = 'internal_error') {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/u.test(code) ? code : fallback;
}

export function sessionCookieName(secure = true) {
  return secure ? SESSION_COOKIE_NAME : DEV_SESSION_COOKIE_NAME;
}

// The `__Host-` prefix requires Secure, which browsers drop over plain http
// (e.g. Safari on http://localhost). Development falls back to a non-Secure,
// SameSite=Lax cookie; production always uses the hardened attributes.
function sessionCookieFlags(secure) {
  return secure ? 'Secure; SameSite=None; Partitioned' : 'SameSite=Lax';
}

export function setSessionCookie(res, token, maxAgeSeconds = Math.floor(SESSION_ABSOLUTE_MS / 1000), { secure = true } = {}) {
  const value = `${sessionCookieName(secure)}=${encodeURIComponent(token)}; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; Path=/; HttpOnly; ${sessionCookieFlags(secure)}`;
  res.setHeader('Set-Cookie', value);
}

export function clearSessionCookie(res, { secure = true } = {}) {
  res.setHeader('Set-Cookie', `${sessionCookieName(secure)}=; Max-Age=0; Path=/; HttpOnly; ${sessionCookieFlags(secure)}`);
}

export function readSessionCookie(req, cookieName = SESSION_COOKIE_NAME) {
  const header = req?.headers?.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === cookieName) {
      try {
        const value = decodeURIComponent(rest.join('='));
        return /^[a-f0-9]{64}$/u.test(value) ? value : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cache-Control', 'no-store');
}

export function isJsonRequest(req) {
  const contentType = req?.headers?.['content-type'];
  return typeof contentType === 'string' && /^application\/json(?:\s*;|\s*$)/iu.test(contentType);
}

export function validBodyObject(body) {
  return Boolean(body && typeof body === 'object' && !Array.isArray(body));
}

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone ?? null,
    addressLine1: row.address_line1 ?? null,
    addressLine2: row.address_line2 ?? null,
    city: row.city ?? null,
    postalCode: row.postal_code ?? null,
    country: row.country ?? null,
    marketingConsent: Boolean(row.marketing_consent),
    emailVerified: Boolean(row.verified_at),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    sheetSyncStatus: row.sheet_sync_status || 'pending',
  };
}

export function timingSafeEqualBuffers(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
