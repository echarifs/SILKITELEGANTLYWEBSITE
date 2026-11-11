import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRegistrationBody } from '../server/auth.js';

test('registration validation normalizes fields and keeps optional values separate', () => {
  const result = validateRegistrationBody({
    name: '  Amélie  ',
    email: ' AMELIE@example.com ',
    phone: ' +212 600 000 000 ',
    password: 'private-velvet-phrase-2026! 𝒮',
    marketingConsent: true,
    termsAccepted: true,
    website: '',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.name, 'Amélie');
  assert.equal(result.email, 'amelie@example.com');
  assert.equal(result.phone, '+212600000000');
  assert.equal(result.marketingConsent, true);
  assert.equal(result.password, 'private-velvet-phrase-2026! 𝒮'.normalize('NFC'));
});

test('registration validation requires explicit terms acceptance and rejects malformed optional fields', () => {
  assert.equal(validateRegistrationBody({
    name: 'Customer', email: 'customer@example.com', phone: 123,
    password: 'a sufficiently long private passphrase 2026', termsAccepted: true,
  }).error, 'invalid');
  assert.equal(validateRegistrationBody({
    name: 'Customer', email: 'customer@example.com', phone: null,
    password: 'a sufficiently long private passphrase 2026', termsAccepted: false,
  }).error, 'invalid');
});

test('registration password strength includes account identifiers as zxcvbn inputs', () => {
  const result = validateRegistrationBody({
    name: 'Customer', email: 'customer@example.com', phone: null,
    password: 'customer customer customer customer', termsAccepted: true,
  });
  assert.equal(result.error, 'password');
});
