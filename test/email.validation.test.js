import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmail } from '../server/security.js';

test('account email accepts one mailbox only, never a recipient list or display-name syntax', () => {
  assert.equal(normalizeEmail('a,b@example.invalid'), null);
  assert.equal(normalizeEmail('Name<owner@example.invalid>'), null);
  assert.equal(normalizeEmail('a;owner@example.invalid'), null);
  assert.equal(normalizeEmail('owner(comment)@example.invalid'), null);
  assert.equal(normalizeEmail('Owner+notes@example.invalid'), 'owner+notes@example.invalid');
});
