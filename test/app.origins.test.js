import test from 'node:test';
import assert from 'node:assert/strict';
import { accountOrigins } from '../server/app.js';

test('development allowlist trusts only exact configured loopback origins for the Preview proxy', () => {
  const origins = accountOrigins({ development: true, port: 3000 });
  assert.equal(origins.has('http://127.0.0.1:3000'), true);
  assert.equal(origins.has('http://localhost:3000'), true);
  assert.equal(origins.has('http://127.0.0.1:3001'), false);
  assert.equal(origins.has('http://localhost.evil.test:3000'), false);
});

test('production origin allowlist never adds loopback HTTP origins', () => {
  const origins = accountOrigins({ development: false, port: 3000 });
  assert.equal(origins.has('http://127.0.0.1:3000'), false);
  assert.equal(origins.has('http://localhost:3000'), false);
});

test('invalid development ports do not produce loopback allowlist entries', () => {
  const origins = accountOrigins({ development: true, port: 70000 });
  assert.equal(origins.has('http://127.0.0.1:70000'), false);
  assert.equal(origins.has('http://localhost:70000'), false);
});
