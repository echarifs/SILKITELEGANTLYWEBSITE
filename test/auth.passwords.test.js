import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, passwordCodepointLength, validatePassword, verifyPassword } from '../server/passwords.js';

test('password policy counts Unicode code points and preserves allowed whitespace', () => {
  const value = '  𝒮ilk-phrase-安全-2026  ';
  assert.equal(passwordCodepointLength(value), Array.from(value.normalize('NFC')).length);
  assert.equal(validatePassword(value).ok, true);
});

test('password policy rejects short and overlong passwords without composition rules', () => {
  assert.equal(validatePassword('a'.repeat(14)).reason, 'too_short');
  assert.equal(validatePassword('a'.repeat(129)).reason, 'too_long');
  assert.equal(validatePassword('A'.repeat(15)).ok, false);
});

test('Argon2 hashes normalized password and verifies the same normalization', async () => {
  const original = '  𝒮ilk phrase with Unicode  ';
  const hash = await hashPassword(original.normalize('NFD'));
  assert.equal(await verifyPassword(original, hash), true);
  assert.equal(await verifyPassword(`${original}x`, hash), false);
  assert.notEqual(hash, original);
});
