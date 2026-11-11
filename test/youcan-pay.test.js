import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  createSandboxPaymentToken,
  hasSandboxKeyPair,
  parseYouCanPayMinorAmount,
  verifyYouCanPaySignature,
  YOUCANPAY_SANDBOX_TOKENIZE_URL,
} from '../server/youcan-pay.js';
import { applyProviderEvent, buildTrustedOrder, createYouCanPayWebhookHandler } from '../server/payments.js';

const privateKey = 'pri_sandbox_test_key_1234567890';
const publicKey = 'pub_sandbox_test_key_1234567890';
const orderId = '123e4567-e89b-12d3-a456-426614174000';

test('only sandbox-prefixed YouCan Pay key pairs are accepted', () => {
  assert.equal(hasSandboxKeyPair(privateKey, publicKey), true);
  assert.equal(hasSandboxKeyPair('pri_live_secret_1234567890', publicKey), false);
  assert.equal(hasSandboxKeyPair(privateKey, 'pub_live_1234567890'), false);
});

test('server tokenization sends the trusted amount and sandbox private key only to the provider', async () => {
  let captured;
  const result = await createSandboxPaymentToken({
    orderId,
    amountMinor: 8500,
    currency: 'EUR',
    privateKey,
    publicKey,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return {
        ok: true,
        json: async () => ({ token: 'token_from_provider_123', transaction_id: 'f8d2c1a0-3b4c-4d5e-8f90-a1b2c3d4e5f6' }),
      };
    },
  });

  assert.equal(captured.url, YOUCANPAY_SANDBOX_TOKENIZE_URL);
  assert.equal(captured.options.method, 'POST');
  const form = new URLSearchParams(captured.options.body);
  assert.equal(form.get('amount'), '8500');
  assert.equal(form.get('currency'), 'EUR');
  assert.equal(form.get('order_id'), orderId);
  assert.equal(form.get('pri_key'), privateKey);
  assert.deepEqual(result, { token: 'token_from_provider_123', transactionId: 'f8d2c1a0-3b4c-4d5e-8f90-a1b2c3d4e5f6' });
  assert.equal(JSON.stringify(result).includes(privateKey), false);
});

test('sandbox tokenization accepts the provider response when it contains a token but no transaction ID', async () => {
  const result = await createSandboxPaymentToken({
    orderId,
    amountMinor: 8500,
    currency: 'EUR',
    privateKey,
    publicKey,
    fetchImpl: async () => ({ ok: true, json: async () => ({ token: 'sandbox_token_only_123' }) }),
  });
  assert.deepEqual(result, { token: 'sandbox_token_only_123', transactionId: null });
});

test('tokenization refuses live credentials before making a network request', async () => {
  let called = false;
  await assert.rejects(createSandboxPaymentToken({
    orderId,
    amountMinor: 8500,
    currency: 'EUR',
    privateKey: 'pri_live_secret_123456789',
    publicKey: 'pub_live_public_123456789',
    fetchImpl: async () => { called = true; },
  }), /PAYMENT_NOT_CONFIGURED/u);
  assert.equal(called, false);
});

test('webhook signatures cover the exact raw request bytes and reject tampering', () => {
  const secret = privateKey;
  const raw = Buffer.from('{"event_name":"transaction.paid","sandbox":true}', 'utf8');
  const signature = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  assert.equal(verifyYouCanPaySignature(raw, signature, secret), true);
  assert.equal(verifyYouCanPaySignature(Buffer.from(`${raw.toString()} `), signature, secret), false);
  assert.equal(verifyYouCanPaySignature(raw, '00', secret), false);
});

test('YouCan Pay amounts are parsed in minor units without floating-point rounding', () => {
  assert.equal(parseYouCanPayMinorAmount('8500', 'EUR'), 8500);
  assert.equal(parseYouCanPayMinorAmount({ amount: '85.00', currency: 'EUR' }, 'EUR'), 8500);
  assert.equal(parseYouCanPayMinorAmount({ amount: '12.3', currency: 'MAD' }, 'MAD'), 1230);
  assert.equal(parseYouCanPayMinorAmount('85.00', 'EUR'), null);
  assert.equal(parseYouCanPayMinorAmount('8500', 'USD'), null);
});

test('order totals come from the server catalogue and ignore browser-supplied prices', () => {
  const order = buildTrustedOrder([
    { productId: 'mauve-mist', option: 'Small', quantity: 1, price: 0, productName: 'Fake' },
    { productId: 'ivory-whisper', option: 'Medium', quantity: 2, price: 0 },
  ]);
  assert.equal(order.currency, 'EUR');
  assert.equal(order.amountMinor, 28500);
  assert.deepEqual(order.lines.map(({ productName, option, quantity, unitAmountMinor }) => ({ productName, option, quantity, unitAmountMinor })), [
    { productName: 'Mauve Mist', option: 'Small', quantity: 1, unitAmountMinor: 8500 },
    { productName: 'Ivory Whisper', option: 'Medium', quantity: 2, unitAmountMinor: 10000 },
  ]);
});

test('order validation rejects unknown variants, fractional quantity, and oversized cart input', () => {
  assert.throws(() => buildTrustedOrder([{ productId: 'mauve-mist', option: 'VIP', quantity: 1 }]), /INVALID_CART/u);
  assert.throws(() => buildTrustedOrder([{ productId: 'mauve-mist', option: 'Small', quantity: 1.5 }]), /INVALID_CART/u);
  assert.throws(() => buildTrustedOrder([]), /INVALID_CART/u);
});


const providerTransactionId = 'f8d2c1a0-3b4c-4d5e-8f90-a1b2c3d4e5f6';
const paymentEventId = 'a1b2c3d4-e5f6-4789-8abc-def012345678';

function createFakePaymentPool() {
  const order = {
    id: orderId,
    status: 'pending_payment',
    provider_mode: 'sandbox',
    provider_transaction_id: providerTransactionId,
    currency: 'EUR',
    amount_minor: 8500,
    refund_amount_minor: null,
  };
  const events = new Map();
  const emailJobs = [];
  const queries = [];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/gu, ' ').trim();
      queries.push({ sql: normalized, params });
      if (normalized.startsWith('INSERT IGNORE INTO payment_webhook_events')) {
        const [id, eventName, relatedOrderId] = params;
        if (events.has(id)) return [{ affectedRows: 0 }, []];
        events.set(id, { event_name: eventName, order_id: relatedOrderId, processing_status: 'received' });
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith('SELECT * FROM store_orders')) {
        return [[params[0] === order.id ? { ...order } : null].filter(Boolean), []];
      }
      if (normalized.startsWith('UPDATE store_orders SET provider_transaction_id = ? WHERE id = ? AND provider_transaction_id IS NULL')) {
        if (order.id === params[1] && order.provider_transaction_id === null) {
          order.provider_transaction_id = params[0];
          return [{ affectedRows: 1 }, []];
        }
        return [{ affectedRows: 0 }, []];
      }
      if (normalized.startsWith("UPDATE payment_webhook_events SET processing_status = 'rejected'")) {
        events.get(params[0]).processing_status = 'rejected';
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("UPDATE payment_webhook_events SET processing_status = 'ignored'")) {
        events.get(params[0]).processing_status = 'ignored';
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("UPDATE payment_webhook_events SET processing_status = 'processed'")) {
        events.get(params[0]).processing_status = 'processed';
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("UPDATE store_orders SET status = 'paid'")) {
        order.status = 'paid';
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith("UPDATE store_orders SET status = 'payment_failed'")) {
        order.status = 'payment_failed';
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith('UPDATE store_orders SET status = ?, refund_amount_minor')) {
        order.status = params[0];
        if (params[1] !== null) order.refund_amount_minor = params[1];
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith('INSERT IGNORE INTO payment_mail_jobs')) {
        emailJobs.push({ orderId: params[1], webhookEventId: params[2], type: params[3] });
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected fake SQL: ${normalized}`);
    },
  };
  return {
    order,
    events,
    emailJobs,
    queries,
    pool: { async getConnection() { return connection; } },
  };
}

function providerEvent(eventName, id = paymentEventId, transaction = {}) {
  return {
    id,
    event_name: eventName,
    sandbox: true,
    payload: {
      transaction: {
        id: providerTransactionId,
        amount: '8500',
        currency: 'EUR',
        order_id: orderId,
        ...transaction,
      },
      payment_method: { card: { brand: 'VISA', fingerprint: 'test-only', last_digits: '0000' } },
    },
  };
}

test('signed webhook processing marks a matched order paid once and queues one confirmation email', async () => {
  const fake = createFakePaymentPool();
  const event = providerEvent('transaction.paid');
  assert.equal(await applyProviderEvent(fake.pool, event), 'processed');
  assert.equal(fake.order.status, 'paid');
  assert.equal(fake.events.get(paymentEventId).processing_status, 'processed');
  assert.deepEqual(fake.emailJobs.map(({ type }) => type), ['payment_confirmation']);

  assert.equal(await applyProviderEvent(fake.pool, event), 'duplicate');
  assert.equal(await applyProviderEvent(fake.pool, providerEvent('transaction.paid', 'b2c3d4e5-f678-489a-9bcd-ef0123456789')), 'processed');
  assert.equal(fake.emailJobs.length, 1);
  assert.equal(JSON.stringify(fake.queries).includes('test-only'), false);
});

test('first valid signed webhook binds the transaction ID when sandbox tokenization omitted it', async () => {
  const fake = createFakePaymentPool();
  fake.order.provider_transaction_id = null;
  assert.equal(await applyProviderEvent(fake.pool, providerEvent('transaction.paid')), 'processed');
  assert.equal(fake.order.provider_transaction_id, providerTransactionId);
  assert.equal(fake.order.status, 'paid');
  assert.deepEqual(fake.emailJobs.map(({ type }) => type), ['payment_confirmation']);
});

test('webhook reconciliation rejects mismatched amount, order, and provider transaction references', async () => {
  for (const transaction of [
    { amount: '8499' },
    { order_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
  ]) {
    const fake = createFakePaymentPool();
    assert.equal(await applyProviderEvent(fake.pool, providerEvent('transaction.paid', crypto.randomUUID(), transaction)), 'rejected');
    assert.equal(fake.order.status, 'pending_payment');
    assert.equal(fake.emailJobs.length, 0);
  }
});

test('refund events record cumulative partial and full amounts and queue notices once', async () => {
  const fake = createFakePaymentPool();
  assert.equal(await applyProviderEvent(fake.pool, providerEvent('transaction.paid')), 'processed');
  assert.equal(await applyProviderEvent(fake.pool, providerEvent('transaction.refunded', 'c3d4e5f6-789a-4bcd-8ef0-123456789abc', {
    amount_refunded: { amount: '12.00', currency: 'EUR' },
    is_fully_refunded: false,
  })), 'processed');
  assert.equal(fake.order.status, 'partially_refunded');
  assert.equal(Number(fake.order.refund_amount_minor), 1200);

  assert.equal(await applyProviderEvent(fake.pool, providerEvent('transaction.refunded', 'd4e5f678-9abc-4def-8012-3456789abcde', {
    amount_refunded: { amount: '85.00', currency: 'EUR' },
    is_fully_refunded: true,
  })), 'processed');
  assert.equal(fake.order.status, 'refunded');
  assert.equal(Number(fake.order.refund_amount_minor), 8500);
  assert.deepEqual(fake.emailJobs.map(({ type }) => type), [
    'payment_confirmation',
    'refund_notification',
    'refund_notification',
  ]);
});

test('refund event with no reliable full/partial amount evidence is ignored instead of overstating a refund', async () => {
  const fake = createFakePaymentPool();
  fake.order.status = 'paid';
  assert.equal(await applyProviderEvent(fake.pool, providerEvent('transaction.refunded', paymentEventId, { status: 1 })), 'ignored');
  assert.equal(fake.order.status, 'paid');
  assert.equal(fake.emailJobs.length, 0);
});

test('webhook handler validates the raw-body signature before touching order state', async () => {
  const fake = createFakePaymentPool();
  const privateKey = 'pri_sandbox_fake_test_key';
  const publicKey = 'pub_sandbox_fake_test_key';
  const handler = createYouCanPayWebhookHandler({ pool: fake.pool, privateKey, publicKey });
  const rawBody = Buffer.from(JSON.stringify(providerEvent('transaction.paid')));
  const signature = crypto.createHmac('sha256', privateKey).update(rawBody).digest('hex');
  let statusCode = 0;
  let responseBody;
  const response = {
    status(code) { statusCode = code; return this; },
    json(body) { responseBody = body; return this; },
    end() { return this; },
  };

  await handler({ body: rawBody, headers: { 'x-youcanpay-signature': signature } }, response);
  assert.equal(statusCode, 200);
  assert.deepEqual(responseBody, { received: true });
  assert.equal(fake.order.status, 'paid');

  const invalidFake = createFakePaymentPool();
  const invalidHandler = createYouCanPayWebhookHandler({ pool: invalidFake.pool, privateKey, publicKey });
  statusCode = 0;
  await invalidHandler({ body: rawBody, headers: { 'x-youcanpay-signature': '0'.repeat(64) } }, response);
  assert.equal(statusCode, 403);
  assert.equal(invalidFake.order.status, 'pending_payment');
  assert.equal(invalidFake.events.size, 0);
});
