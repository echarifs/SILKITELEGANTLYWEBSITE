import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  hashToken,
  isAllowedOrigin,
  normalizeEmail,
  readSessionCookie,
  setSessionCookie,
  timingSafeEqualBuffers,
} from '../server/security.js';

test('email normalization is deterministic and rejects whitespace/control input', () => {
  assert.equal(normalizeEmail('  Customer@Example.COM '), 'customer@example.com');
  assert.equal(normalizeEmail('customer @example.com'), null);
  assert.equal(normalizeEmail('customer@example.com\n'), 'customer@example.com');
  assert.equal(normalizeEmail('customer@@example.com'), null);
});

test('origin allowlist accepts exact origins only', () => {
  const allowlist = new Set(['https://preview.example']);
  assert.equal(isAllowedOrigin('https://preview.example', allowlist), true);
  assert.equal(isAllowedOrigin('https://preview.example.evil.test', allowlist), false);
  assert.equal(isAllowedOrigin('https://preview.example/path', allowlist), false);
  assert.equal(isAllowedOrigin(undefined, allowlist), false);
});

test('session cookie is opaque, host-only, secure, partitioned, and readable only in exact format', () => {
  let value;
  const response = { setHeader(name, header) { if (name === 'Set-Cookie') value = header; } };
  const token = 'a'.repeat(64);
  setSessionCookie(response, token, 120);
  assert.match(value, new RegExp(`^${SESSION_COOKIE_NAME}=`));
  assert.match(value, /HttpOnly/);
  assert.match(value, /Secure/);
  assert.match(value, /SameSite=None/);
  assert.match(value, /Partitioned/);
  assert.match(value, /Path=\//);
  assert.equal(value.includes('Domain='), false);
  assert.equal(readSessionCookie({ headers: { cookie: value } }), token);
  assert.equal(readSessionCookie({ headers: { cookie: `${SESSION_COOKIE_NAME}=not-a-token` } }), null);

  clearSessionCookie(response);
  assert.match(value, new RegExp(`^${SESSION_COOKIE_NAME}=; Max-Age=0`));
  assert.match(value, /Partitioned/);
});

test('token hashing and CSRF comparison are fixed-length timing-safe values', () => {
  const one = hashToken('secret');
  const two = hashToken('secret');
  assert.equal(one.length, 32);
  assert.equal(timingSafeEqualBuffers(one, two), true);
  assert.equal(timingSafeEqualBuffers(one, hashToken('other')), false);
  assert.equal(timingSafeEqualBuffers(one, Buffer.alloc(1)), false);
});
