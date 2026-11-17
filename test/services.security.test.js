import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPrivatePermissions, chooseCustomerRow, customerSheetValues, CUSTOMER_HEADERS } from '../server/sheets.js';
import { ORDERS_SHEET_ID, orderSheetValues, ORDER_HEADERS } from '../server/order-sheets.js';
import { authenticatedMailboxFromSmtpUrl, classifySmtpFailure, createMailService } from '../server/mail.js';

test('customer spreadsheet refuses public and domain-wide sharing', () => {
  assert.throws(() => assertPrivatePermissions([{ type: 'anyone', role: 'reader' }]));
  assert.throws(() => assertPrivatePermissions([{ type: 'domain', role: 'reader' }]));
  assert.throws(() => assertPrivatePermissions([]));
  assert.doesNotThrow(() => assertPrivatePermissions([{ type: 'user', role: 'owner' }, { type: 'user', role: 'writer' }]));
});

test('stable customer IDs reuse rows on retry and duplicate IDs fail closed', () => {
  assert.equal(chooseCustomerRow([['first'], ['second']], 'second'), 3);
  assert.equal(chooseCustomerRow([['first'], []], 'new'), 3);
  assert.equal(chooseCustomerRow([], 'new'), 2);
  assert.throws(() => chooseCustomerRow([['same'], ['same']], 'same'));
});

test('spreadsheet projection includes profile fields only, never hashes or tokens', () => {
  const user = { id: 'safe-id', name: '=DO_NOT_EVALUATE()', email: 'test@example.invalid', phone: '', marketing_consent: false, created_at: new Date('2026-01-01Z'), verified_at: new Date('2026-01-02Z'), password_hash: 'SECRET_HASH', token: 'SECRET_TOKEN' };
  const values = customerSheetValues(user);
  assert.equal(values.length, CUSTOMER_HEADERS.length);
  assert.equal(values[1], '=DO_NOT_EVALUATE()'); // RAW API writes preserve this as text.
  assert.ok(!values.includes('SECRET_HASH'));
  assert.ok(!values.includes('SECRET_TOKEN'));
});

test('the owner orders spreadsheet is only ever the configured one', () => {
  assert.equal(ORDERS_SHEET_ID, '1fPc0toqXfTqgxPi2oztW4MSumAXhwYjxQCZb42Hx1k8');
});

test('order row projection covers ids, delivery confirmation, and delivery info', () => {
  const order = {
    id: 'order-uuid-1',
    reference: 'ORDERREF01',
    createdAt: new Date('2026-11-17T10:30:00Z'),
    paymentMethod: 'cod',
    status: 'pending_payment',
    name: 'Amal Weaver',
    email: 'amal@example.invalid',
    phone: '+212612345678',
    lines: [
      { productName: 'Mauve Mist', option: 'Small', quantity: 1 },
      { productName: 'Amber Dune', option: 'Large', quantity: 2 },
    ],
    currency: 'MAD',
    amountMinor: 20500,
    shipping: { line1: '12 Silk Road', line2: 'Riad wing', city: 'Casablanca', postalCode: '20000', country: 'MA' },
  };
  const values = orderSheetValues(order);
  assert.equal(values.length, ORDER_HEADERS.length);
  assert.deepEqual([values[0], values[1], values[2]], ['order-uuid-1', 'ORDERREF01', '2026-11-17T10:30:00.000Z']);
  assert.equal(values[3], 'Cash on delivery');
  assert.equal(values[4], 'Awaiting payment');
  assert.equal(values[5], 'Yes', 'delivery details present means delivery is confirmed');
  assert.deepEqual(values.slice(9), [
    'Mauve Mist (Small) × 1; Amber Dune (Large) × 2',
    '205.00', 'MAD',
    '12 Silk Road', 'Riad wing', 'Casablanca', '20000', 'MA',
  ]);
});

test('an order without delivery details shows them as unconfirmed and blank', () => {
  const values = orderSheetValues({
    id: 'order-uuid-2', reference: 'ORDERREF02', createdAt: new Date('2026-11-17T10:30:00Z'),
    paymentMethod: 'youcanpay', status: 'paid', name: 'Paid Weaver', email: 'paid@example.invalid',
    lines: [], currency: 'MAD', amountMinor: 8500, shipping: null,
  });
  assert.equal(values[3], 'Card');
  assert.equal(values[4], 'Paid');
  assert.equal(values[5], 'No');
  assert.deepEqual(values.slice(12), ['', '', '', '', '']);
});

test('invalid SMTP configuration fails without network access or secret output', async () => {
  const mail = createMailService({ smtpUrl: 'invalid' });
  assert.equal(mail.configured, false);
  assert.deepEqual(await mail.verifyConnection(), { ok: false, code: 'SMTP_CONFIGURATION_INVALID' });
  await assert.rejects(() => mail.sendVerification({}), /EMAIL_UNAVAILABLE/);
  mail.close();
});

test('invalid Resend configuration fails closed without network access', async () => {
  const mail = createMailService({ resendApiKey: 'not-a-key', mailFrom: 'SilkItElegantly <no-reply@silkitelegantly.com>' });
  assert.equal(mail.configured, false);
  assert.deepEqual(await mail.verifyConnection(), { ok: false, code: 'EMAIL_CONFIGURATION_INVALID' });
  await assert.rejects(() => mail.sendVerification({}), /EMAIL_UNAVAILABLE/);
  mail.close();
});

test('transactional mail sender is the URL-decoded authenticated SMTP mailbox', () => {
  assert.equal(authenticatedMailboxFromSmtpUrl('smtps://accounts%40example.test:placeholder@mail.privateemail.com:465'), 'accounts@example.test');
});

test('SMTP errors are reduced to coarse safe categories', () => {
  assert.equal(classifySmtpFailure({ code: 'EAUTH', response: 'private response text' }), 'SMTP_AUTHENTICATION_FAILED');
  assert.equal(classifySmtpFailure({ code: 'ETIMEDOUT' }), 'SMTP_CONNECTION_FAILED');
  assert.equal(classifySmtpFailure({ code: 'EENVELOPE', responseCode: 550 }), 'SMTP_REJECTED');
  assert.equal(classifySmtpFailure({ responseCode: 451 }), 'SMTP_TEMPORARY_FAILURE');
  assert.equal(classifySmtpFailure({ code: 'UNKNOWN', response: 'private response text' }), 'SMTP_SEND_FAILED');
});
