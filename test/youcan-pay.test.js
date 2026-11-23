import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import {
  createPaymentToken,
  hasLiveKeyPair,
  hasSandboxKeyPair,
  parseYouCanPayMinorAmount,
  resolveKeyMode,
  verifyYouCanPaySignature,
  YOUCANPAY_LIVE_TOKENIZE_URL,
  YOUCANPAY_SANDBOX_TOKENIZE_URL,
} from '../server/youcan-pay.js';
import {
  applyProviderEvent,
  buildTrustedOrder,
  createPaymentsRouter,
  createYouCanPayWebhookHandler,
  migrateOrderShipping,
} from '../server/payments.js';

const privateKey = 'pri_sandbox_test_key_1234567890';
const publicKey = 'pub_sandbox_test_key_1234567890';
const livePrivateKey = 'pri_live_secret_123456789';
const livePublicKey = 'pub_live_public_123456789';
const orderId = '123e4567-e89b-12d3-a456-426614174000';

test('YouCan Pay key pairs are classified as sandbox or live, never both', () => {
  assert.equal(hasSandboxKeyPair(privateKey, publicKey), true);
  assert.equal(hasSandboxKeyPair(livePrivateKey, publicKey), false);
  assert.equal(hasSandboxKeyPair(privateKey, livePublicKey), false);
  assert.equal(hasLiveKeyPair(privateKey, publicKey), false);
  assert.equal(hasLiveKeyPair(livePrivateKey, livePublicKey), true);
  assert.equal(hasLiveKeyPair(livePrivateKey, publicKey), false);
  assert.equal(hasLiveKeyPair(privateKey, livePublicKey), false);
  assert.equal(resolveKeyMode(livePrivateKey, livePublicKey), 'live');
  assert.equal(resolveKeyMode(privateKey, publicKey), 'sandbox');
  assert.equal(resolveKeyMode(livePrivateKey, publicKey), null);
  assert.equal(resolveKeyMode(undefined, undefined), null);
});

test('server tokenization sends the trusted amount and sandbox private key only to the provider', async () => {
  let captured;
  const result = await createPaymentToken({
    orderId,
    amountMinor: 93500,
    currency: 'MAD',
    privateKey,
    publicKey,
    mode: 'sandbox',
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
  assert.equal(form.get('amount'), '93500');
  assert.equal(form.get('currency'), 'MAD');
  assert.equal(form.get('order_id'), orderId);
  assert.equal(form.get('pri_key'), privateKey);
  assert.deepEqual(result, { token: 'token_from_provider_123', transactionId: 'f8d2c1a0-3b4c-4d5e-8f90-a1b2c3d4e5f6' });
  assert.equal(JSON.stringify(result).includes(privateKey), false);
});

test('sandbox tokenization accepts the provider response when it contains a token but no transaction ID', async () => {
  const result = await createPaymentToken({
    orderId,
    amountMinor: 93500,
    currency: 'MAD',
    privateKey,
    publicKey,
    mode: 'sandbox',
    fetchImpl: async () => ({ ok: true, json: async () => ({ token: 'sandbox_token_only_123' }) }),
  });
  assert.deepEqual(result, { token: 'sandbox_token_only_123', transactionId: null });
});

test('live tokenization routes to the live endpoint only with the matching key pair', async () => {
  let captured;
  const result = await createPaymentToken({
    orderId,
    amountMinor: 93500,
    currency: 'MAD',
    privateKey: livePrivateKey,
    publicKey: livePublicKey,
    mode: 'live',
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return {
        ok: true,
        json: async () => ({ token: 'live_token_from_provider', transaction_id: 'f8d2c1a0-3b4c-4d5e-8f90-a1b2c3d4e5f6' }),
      };
    },
  });
  assert.equal(captured.url, YOUCANPAY_LIVE_TOKENIZE_URL);
  assert.equal(captured.options.method, 'POST');
  const form = new URLSearchParams(captured.options.body);
  assert.equal(form.get('pri_key'), livePrivateKey);
  assert.equal(form.get('currency'), 'MAD');
  assert.equal(result.token, 'live_token_from_provider');
});

test('tokenization refuses a mode that does not match the key pair before making a network request', async () => {
  let called = false;
  await assert.rejects(createPaymentToken({
    orderId,
    amountMinor: 93500,
    currency: 'MAD',
    privateKey: livePrivateKey,
    publicKey: livePublicKey,
    mode: 'sandbox',
    fetchImpl: async () => { called = true; },
  }), /PAYMENT_NOT_CONFIGURED/u);
  await assert.rejects(createPaymentToken({
    orderId,
    amountMinor: 93500,
    currency: 'MAD',
    privateKey,
    publicKey,
    mode: 'live',
    fetchImpl: async () => { called = true; },
  }), /PAYMENT_NOT_CONFIGURED/u);
  await assert.rejects(createPaymentToken({
    orderId,
    amountMinor: 93500,
    currency: 'MAD',
    privateKey: 'pri_live_secret_123456789',
    publicKey: 'pub_sandbox_mismatched_key',
    mode: 'live',
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
  assert.equal(order.currency, 'MAD');
  assert.equal(order.amountMinor, 1200000);
  assert.deepEqual(order.lines.map(({ productName, option, quantity, unitAmountMinor }) => ({ productName, option, quantity, unitAmountMinor })), [
    { productName: 'Mauve Mist', option: 'Small', quantity: 1, unitAmountMinor: 400000 },
    { productName: 'Ivory Whisper', option: 'Medium', quantity: 2, unitAmountMinor: 400000 },
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
    currency: 'MAD',
    amount_minor: 93500,
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

function providerEvent(eventName, id = paymentEventId, transaction = {}, { sandbox = true } = {}) {
  return {
    id,
    event_name: eventName,
    sandbox,
    payload: {
      transaction: {
        id: providerTransactionId,
        amount: '93500',
        currency: 'MAD',
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

test('live webhook events match live orders and ignore events from the wrong environment', async () => {
  const fake = createFakePaymentPool();
  fake.order.provider_mode = 'live';
  const liveEvent = providerEvent('transaction.paid', crypto.randomUUID(), {}, { sandbox: false });
  assert.equal(await applyProviderEvent(fake.pool, liveEvent), 'processed');
  assert.equal(fake.order.status, 'paid');
  assert.deepEqual(fake.emailJobs.map(({ type }) => type), ['payment_confirmation']);

  // A sandbox event must never touch a live order, and vice versa.
  const sandboxFake = createFakePaymentPool();
  sandboxFake.order.provider_mode = 'live';
  assert.equal(await applyProviderEvent(sandboxFake.pool, providerEvent('transaction.paid', crypto.randomUUID())), 'rejected');
  assert.equal(sandboxFake.order.status, 'pending_payment');
  assert.equal(sandboxFake.emailJobs.length, 0);

  const liveFake = createFakePaymentPool();
  assert.equal(await applyProviderEvent(liveFake.pool, providerEvent('transaction.paid', crypto.randomUUID(), {}, { sandbox: false })), 'rejected');
  assert.equal(liveFake.order.status, 'pending_payment');
  assert.equal(liveFake.emailJobs.length, 0);
});

test('refund events record cumulative partial and full amounts and queue notices once', async () => {
  const fake = createFakePaymentPool();
  assert.equal(await applyProviderEvent(fake.pool, providerEvent('transaction.paid')), 'processed');
  assert.equal(await applyProviderEvent(fake.pool, providerEvent('transaction.refunded', 'c3d4e5f6-789a-4bcd-8ef0-123456789abc', {
    amount_refunded: { amount: '12.00', currency: 'MAD' },
    is_fully_refunded: false,
  })), 'processed');
  assert.equal(fake.order.status, 'partially_refunded');
  assert.equal(Number(fake.order.refund_amount_minor), 1200);

  assert.equal(await applyProviderEvent(fake.pool, providerEvent('transaction.refunded', 'd4e5f678-9abc-4def-8012-3456789abcde', {
    amount_refunded: { amount: '935.00', currency: 'MAD' },
    is_fully_refunded: true,
  })), 'processed');
  assert.equal(fake.order.status, 'refunded');
  assert.equal(Number(fake.order.refund_amount_minor), 93500);
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

test('webhook handler accepts live keys and verifies live events against the live secret', async () => {
  const fake = createFakePaymentPool();
  fake.order.provider_mode = 'live';
  const handler = createYouCanPayWebhookHandler({ pool: fake.pool, livePrivateKey, livePublicKey });
  const paidEvent = { ...providerEvent('transaction.paid', crypto.randomUUID(), {}, { sandbox: false }) };
  const rawBody = Buffer.from(JSON.stringify(paidEvent));
  const signature = crypto.createHmac('sha256', livePrivateKey).update(rawBody).digest('hex');
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

  const sandboxSigned = { ...providerEvent('transaction.paid', crypto.randomUUID()) };
  const sandboxBody = Buffer.from(JSON.stringify(sandboxSigned));
  const sandboxSignature = crypto.createHmac('sha256', privateKey).update(sandboxBody).digest('hex');
  const wrongEnvFake = createFakePaymentPool();
  statusCode = 0;
  await createYouCanPayWebhookHandler({ pool: wrongEnvFake.pool, livePrivateKey, livePublicKey })(
    { body: sandboxBody, headers: { 'x-youcanpay-signature': sandboxSignature } },
    response,
  );
  assert.equal(statusCode, 403, 'an event signed with the sandbox secret must not verify against live keys');
  assert.equal(wrongEnvFake.order.status, 'pending_payment');
});

function compact(sql) {
  return sql.replace(/\s+/gu, ' ').trim();
}

// Pool for the public payment routes: supports both top-level pool.query and
// the rate-limit transaction (getConnection). Rate limits always pass.
function createRoutePool({ orderRows = [] } = {}) {
  const orders = new Map();
  const attempted = [];
  const rateRows = new Map();
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async query(sql, params = []) {
      const normalized = compact(sql);
      if (normalized.startsWith('INSERT IGNORE INTO auth_rate_limits')) {
        if (!rateRows.has(params[0])) {
          rateRows.set(params[0], { window_started_at: new Date(), attempts: 0, blocked_until: null });
        }
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith('SELECT * FROM auth_rate_limits WHERE bucket_key = ? LIMIT 1 FOR UPDATE')) {
        return [[rateRows.get(params[0])].filter(Boolean), []];
      }
      if (normalized.startsWith('UPDATE auth_rate_limits SET')) {
        const row = rateRows.get(params[0]);
        if (row) row.attempts += 1;
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected fake SQL: ${normalized}`);
    },
  };
  const pool = {
    queries: attempted,
    rateRows,
    async query(sql, params = []) {
      const normalized = compact(sql);
      attempted.push({ sql: normalized, params });
      if (normalized.startsWith('INSERT INTO store_orders')) {
        const [id] = params;
        orders.set(id, {
          id,
          customer_email: params[2],
          status: 'pending_payment',
          shipping_set_at: null,
        });
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith('UPDATE store_orders SET status =')) {
        const found = orders.get(params[1] ?? params[0]);
        if (found) found.status = normalized.includes('refund') ? params[0] : 'payment_failed';
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith('UPDATE store_orders SET provider_transaction_id')) {
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.startsWith('SELECT customer_email, status, shipping_set_at FROM store_orders')) {
        return [[orders.get(params[0])].filter(Boolean), []];
      }
      if (normalized.startsWith('UPDATE store_orders SET shipping_line1')) {
        const found = orders.get(params[6]);
        if (!found || found.shipping_set_at) return [{ affectedRows: 0 }, []];
        found.shipping_set_at = new Date();
        found.shipping = { line1: params[0], line2: params[1], city: params[2], postalCode: params[3], country: params[4], phone: params[5] };
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected fake SQL: ${normalized}`);
    },
    async getConnection() { return connection; },
  };
  return { pool, orders, attempted };
}

function paymentsApp(pool, { privateKey: routePrivate, publicKey: routePublic, livePrivateKey: routeLivePrivate, livePublicKey: routeLivePublic, mail: routeMail, orderSheets: routeOrderSheets } = {}) {
  const app = express();
  app.use(createPaymentsRouter({
    pool,
    allowedOrigins: new Set(['https://shop.example.invalid']),
    privateKey: routePrivate ?? privateKey,
    publicKey: routePublic ?? publicKey,
    livePrivateKey: routeLivePrivate,
    livePublicKey: routeLivePublic,
    mail: routeMail,
    orderSheets: routeOrderSheets,
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => ({ token: url === YOUCANPAY_LIVE_TOKENIZE_URL ? 'route_live_token_123' : 'route_token_123', transaction_id: 'cfdf4b2e-93f2-4f0f-8b7a-5f2d1a0c9e8b' }),
    }),
  }));
  return app;
}

const CHECKOUT_SHIPPING = { line1: '12 Silk Road', line2: 'Riad wing', city: 'Casablanca', postalCode: '20000', country: 'MA' };

test('checkout requires the delivery address and returns a card session', async () => {
  const fake = createRoutePool();
  const response = await request(paymentsApp(fake.pool)).post('/checkout')
    .set('Origin', 'https://shop.example.invalid')
    .set('Content-Type', 'application/json')
    .send({
      customer: { name: 'Safia Weaver', email: 'safia@example.com', phone: '+212612345678' },
      shipping: CHECKOUT_SHIPPING,
      items: [{ productId: 'mauve-mist', option: 'Small', quantity: 1 }],
    });
  assert.equal(response.status, 201);
  assert.equal(response.body.mode, 'sandbox');
  assert.ok(response.body.orderId);
  const insert = fake.attempted.find(({ sql }) => sql.startsWith('INSERT INTO store_orders'));
  assert.ok(insert, 'order insert ran');
  assert.equal(insert.params[3], '+212612345678');
  assert.equal(insert.params[7], 'youcanpay', 'card orders record the payment provider');
  assert.equal(insert.params[8], 'sandbox', 'provider mode is stored with the order');
  assert.deepEqual(insert.params.slice(9, 14), ['12 Silk Road', 'Riad wing', 'Casablanca', '20000', 'MA']);
});

test('cash on delivery is refused outside Morocco and Western Sahara while card orders are accepted anywhere', async () => {
  const codFake = createRoutePool();
  const codResponse = await request(paymentsApp(codFake.pool, { privateKey: 'pri_live_mismatched', publicKey })).post('/checkout')
    .set('Origin', 'https://shop.example.invalid')
    .set('Content-Type', 'application/json')
    .send({
      paymentMethod: 'cod',
      customer: { name: 'Cash Weaver', email: 'cash@example.com', phone: '+212612345678' },
      shipping: { ...CHECKOUT_SHIPPING, country: 'FR' },
      items: [{ productId: 'mauve-mist', option: 'Small', quantity: 1 }],
    });
  assert.equal(codResponse.status, 400);
  assert.equal(codResponse.body.error, 'cod_not_available');
  assert.equal(codFake.attempted.some(({ sql }) => sql.startsWith('INSERT INTO store_orders')), false);

  const saharaFake = createRoutePool();
  const saharaResponse = await request(paymentsApp(saharaFake.pool, { privateKey: 'pri_live_mismatched', publicKey })).post('/checkout')
    .set('Origin', 'https://shop.example.invalid')
    .set('Content-Type', 'application/json')
    .send({
      paymentMethod: 'cod',
      customer: { name: 'Sahara Weaver', email: 'sahara@example.com', phone: '+212612345678' },
      shipping: { ...CHECKOUT_SHIPPING, city: 'Laayoune', country: 'EH' },
      items: [{ productId: 'mauve-mist', option: 'Small', quantity: 1 }],
    });
  assert.equal(saharaResponse.status, 201, 'Western Sahara orders are cash-on-delivery too');
  assert.equal(saharaResponse.body.mode, 'cod');

  const cardFake = createRoutePool();
  const cardResponse = await request(paymentsApp(cardFake.pool)).post('/checkout')
    .set('Origin', 'https://shop.example.invalid')
    .set('Content-Type', 'application/json')
    .send({
      customer: { name: 'Card Weaver', email: 'card@example.com', phone: '+212612345678' },
      shipping: { ...CHECKOUT_SHIPPING, country: 'FR' },
      items: [{ productId: 'mauve-mist', option: 'Small', quantity: 1 }],
    });
  assert.equal(cardResponse.status, 201);
  assert.equal(cardResponse.body.mode, 'sandbox');
});

test('checkout with live keys charges live and stores provider_mode = live', async () => {
  const fake = createRoutePool();
  const response = await request(paymentsApp(fake.pool, { livePrivateKey, livePublicKey })).post('/checkout')
    .set('Origin', 'https://shop.example.invalid')
    .set('Content-Type', 'application/json')
    .send({
      customer: { name: 'Live Weaver', email: 'live@example.com', phone: '+212612345678' },
      shipping: CHECKOUT_SHIPPING,
      items: [{ productId: 'mauve-mist', option: 'Small', quantity: 1 }],
    });
  assert.equal(response.status, 201);
  assert.equal(response.body.mode, 'live');
  assert.equal(response.body.token, 'route_live_token_123');
  assert.equal(response.body.publicKey, livePublicKey);
  const insert = fake.attempted.find(({ sql }) => sql.startsWith('INSERT INTO store_orders'));
  assert.equal(insert.params[8], 'live');
});

test('checkout without any usable key pair reports payments as unconfigured', async () => {
  const fake = createRoutePool();
  const response = await request(paymentsApp(fake.pool, { privateKey: 'pri_live_mismatched', publicKey })).post('/checkout')
    .set('Origin', 'https://shop.example.invalid')
    .set('Content-Type', 'application/json')
    .send({
      customer: { name: 'No Keys', email: 'nokeys@example.com', phone: '' },
      items: [{ productId: 'mauve-mist', option: 'Small', quantity: 1 }],
    });
  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'payments_not_configured');
});

test('checkout requires a delivery address, a phone, and a known payment method', async () => {
  const base = {
    customer: { name: 'Guest Weaver', email: 'guest@example.com', phone: '+212612345678' },
    shipping: CHECKOUT_SHIPPING,
    items: [{ productId: 'mauve-mist', option: 'Small', quantity: 1 }],
  };
  const cases = [
    ['a missing delivery address', { ...base, shipping: undefined }],
    ['a missing phone', { ...base, customer: { ...base.customer, phone: '' } }],
    ['an unknown payment method', { ...base, paymentMethod: 'paypal' }],
  ];
  for (const [label, payload] of cases) {
    const fake = createRoutePool();
    const response = await request(paymentsApp(fake.pool)).post('/checkout')
      .set('Origin', 'https://shop.example.invalid')
      .set('Content-Type', 'application/json')
      .send(payload);
    assert.equal(response.status, 400, `checkout should reject ${label}`);
    assert.equal(response.body.error, 'invalid_checkout');
    assert.equal(fake.attempted.some(({ sql }) => sql.startsWith('INSERT INTO store_orders')), false, `no order is written for ${label}`);
  }
});

test('cash-on-delivery orders skip the payment provider entirely and mail customer and owner once', async () => {
  const fake = createRoutePool();
  const sent = [];
  const mail = {
    async sendOrderPlaced(input) { sent.push({ kind: 'order_placed', input }); },
    async notifyOrderPlaced(input) { sent.push({ kind: 'owner_notice', input }); },
  };
  const response = await request(paymentsApp(fake.pool, { privateKey: 'pri_live_mismatched', publicKey, mail })).post('/checkout')
    .set('Origin', 'https://shop.example.invalid')
    .set('Content-Type', 'application/json')
    .send({
      paymentMethod: 'cod',
      customer: { name: 'Cash Weaver', email: 'cash@example.com', phone: '+212612345678' },
      shipping: CHECKOUT_SHIPPING,
      items: [{ productId: 'mauve-mist', option: 'Small', quantity: 1 }],
    });
  assert.equal(response.status, 201);
  assert.equal(response.body.mode, 'cod');
  assert.equal(response.body.currency, 'MAD');
  assert.equal(response.body.amountMinor, 400000);
  assert.ok(response.body.orderId);
  assert.ok(response.body.orderReference);
  assert.equal(response.body.token, undefined, 'cash on delivery never tokenizes a card');
  const insert = fake.attempted.find(({ sql }) => sql.startsWith('INSERT INTO store_orders'));
  assert.equal(insert.params[7], 'cod', 'the order records its cod provider');
  assert.equal(insert.params[8], 'none', 'cod orders carry no provider mode');
  assert.deepEqual(insert.params.slice(9, 14), ['12 Silk Road', 'Riad wing', 'Casablanca', '20000', 'MA']);
  assert.deepEqual(sent.map(({ kind }) => kind), ['order_placed', 'owner_notice']);
  assert.deepEqual(sent.map(({ input }) => input.orderId), [response.body.orderId, response.body.orderId]);
  assert.equal(sent[1].input.phone, '+212612345678');
  assert.equal(fake.attempted.some(({ sql }) => sql.startsWith('INSERT IGNORE INTO payment_mail_jobs')), false, 'cod stays out of the card payment mail queue');
});

test('a placed order is mirrored into the owner spreadsheet with its delivery info', async () => {
  const fake = createRoutePool();
  const mirrored = [];
  const orderSheets = { async syncOrder(order) { mirrored.push(order); } };
  const response = await request(paymentsApp(fake.pool, { privateKey: 'pri_live_mismatched', publicKey, orderSheets })).post('/checkout')
    .set('Origin', 'https://shop.example.invalid')
    .set('Content-Type', 'application/json')
    .send({
      paymentMethod: 'cod',
      customer: { name: 'Cash Weaver', email: 'cash@example.com', phone: '+212612345678' },
      shipping: CHECKOUT_SHIPPING,
      items: [{ productId: 'mauve-mist', option: 'Small', quantity: 1 }],
    });
  assert.equal(response.status, 201);
  assert.equal(mirrored.length, 1);
  const order = mirrored[0];
  assert.equal(order.id, response.body.orderId);
  assert.equal(order.reference, response.body.orderReference);
  assert.match(order.reference, /^SE-[0-9A-F]{8}$/u, 'order references carry the SE brand prefix');
  assert.equal(order.paymentMethod, 'cod');
  assert.equal(order.status, 'pending_payment');
  assert.equal(order.name, 'Cash Weaver');
  assert.equal(order.phone, '+212612345678');
  assert.deepEqual(order.shipping, CHECKOUT_SHIPPING);
  assert.equal(order.currency, 'MAD');
  assert.equal(order.amountMinor, 400000);
  assert.deepEqual(order.lines.map(({ productName, option, quantity }) => ({ productName, option, quantity })),
    [{ productName: 'Mauve Mist', option: 'Small', quantity: 1 }]);
  assert.ok(order.createdAt instanceof Date);
});

test('a spreadsheet outage never fails a placed order', async () => {
  const fake = createRoutePool();
  const orderSheets = { async syncOrder() { throw new Error('ORDER_SYNC_FAILED'); } };
  const mail = { async sendOrderPlaced() {}, async notifyOrderPlaced() {} };
  const response = await request(paymentsApp(fake.pool, { privateKey: 'pri_live_mismatched', publicKey, mail, orderSheets })).post('/checkout')
    .set('Origin', 'https://shop.example.invalid')
    .set('Content-Type', 'application/json')
    .send({
      paymentMethod: 'cod',
      customer: { name: 'Cash Weaver', email: 'cash@example.com', phone: '+212612345678' },
      shipping: CHECKOUT_SHIPPING,
      items: [{ productId: 'mauve-mist', option: 'Small', quantity: 1 }],
    });
  assert.equal(response.status, 201);
  assert.equal(response.body.mode, 'cod');
});

test('a failing order email never fails a cash-on-delivery order', async () => {
  const fake = createRoutePool();
  const mail = {
    async sendOrderPlaced() { throw new Error('smtp down'); },
    async notifyOrderPlaced() { throw new Error('smtp down'); },
  };
  const response = await request(paymentsApp(fake.pool, { mail })).post('/checkout')
    .set('Origin', 'https://shop.example.invalid')
    .set('Content-Type', 'application/json')
    .send({
      paymentMethod: 'cod',
      customer: { name: 'Cash Weaver', email: 'cash@example.com', phone: '+212612345678' },
      shipping: CHECKOUT_SHIPPING,
      items: [{ productId: 'mauve-mist', option: 'Small', quantity: 1 }],
    });
  assert.equal(response.status, 201);
  assert.equal(response.body.mode, 'cod');
});

test('bank-transfer orders record the order from any country and need no payment keys', async () => {
  const fake = createRoutePool();
  const sent = [];
  const mail = {
    async sendOrderPlaced(input) { sent.push({ kind: 'order_placed', input }); },
    async notifyOrderPlaced(input) { sent.push({ kind: 'owner_notice', input }); },
  };
  // Mismatched key pair: the card branch would answer 503 without touching the DB.
  const response = await request(paymentsApp(fake.pool, { privateKey: 'pri_live_mismatched', publicKey, mail })).post('/checkout')
    .set('Origin', 'https://shop.example.invalid')
    .set('Content-Type', 'application/json')
    .send({
      paymentMethod: 'bank_transfer',
      customer: { name: 'Transfer Weaver', email: 'transfer@example.com', phone: '+33612345678' },
      shipping: { ...CHECKOUT_SHIPPING, country: 'FR' },
      items: [{ productId: 'mauve-mist', option: 'Small', quantity: 1 }],
    });
  assert.equal(response.status, 201);
  assert.equal(response.body.mode, 'bank_transfer');
  assert.equal(response.body.currency, 'MAD');
  assert.equal(response.body.token, undefined, 'bank transfer never tokenizes a card');
  const insert = fake.attempted.find(({ sql }) => sql.startsWith('INSERT INTO store_orders'));
  assert.equal(insert.params[7], 'bank_transfer', 'the order records its bank-transfer provider');
  assert.equal(insert.params[8], 'none', 'bank-transfer orders carry no provider mode');
  assert.deepEqual(insert.params.slice(9, 14), ['12 Silk Road', 'Riad wing', 'Casablanca', '20000', 'FR']);
  assert.deepEqual(sent.map(({ kind }) => kind), ['order_placed', 'owner_notice']);
  assert.equal(sent[0].input.paymentMethod, 'bank_transfer');
  assert.equal(sent[1].input.paymentMethod, 'bank_transfer');
  assert.equal(sent[1].input.phone, '+33612345678');
  assert.equal(fake.attempted.some(({ sql }) => sql.startsWith('INSERT IGNORE INTO payment_mail_jobs')), false);
});

test('delivery details accept the paid order once and validate the payer email', async () => {
  const seed = createRoutePool();
  await request(paymentsApp(seed.pool)).post('/checkout')
    .set('Origin', 'https://shop.example.invalid')
    .set('Content-Type', 'application/json')
    .send({
      customer: { name: 'Guest Weaver', email: 'guest@example.com', phone: '+212612345678' },
      shipping: CHECKOUT_SHIPPING,
      items: [{ productId: 'mauve-mist', option: 'Small', quantity: 1 }],
    });
  const seededOrder = [...seed.orders.values()][0];
  const { pool, orders, attempted } = createRoutePool();
  // Reuse the seeded order id as an already-paid order on a fresh mock pool.
  orders.set(seededOrder.id, {
    id: seededOrder.id,
    customer_email: 'guest@example.com',
    status: 'paid',
    shipping_set_at: null,
  });
  const app = paymentsApp(pool);
  const route = () => request(app).post('/shipping-details')
    .set('Origin', 'https://shop.example.invalid')
    .set('Content-Type', 'application/json');

  const wrongEmail = await route()
    .send({ orderId: seededOrder.id, email: 'other@example.com', ...CHECKOUT_SHIPPING });
  assert.equal(wrongEmail.status, 404);
  assert.equal(wrongEmail.body.error, 'order_not_found');

  const badCountry = await route()
    .send({ orderId: seededOrder.id, email: 'guest@example.com', ...CHECKOUT_SHIPPING, country: 'ZZ' });
  assert.equal(badCountry.status, 400);
  assert.equal(badCountry.body.error, 'invalid_shipping');

  const order = orders.get(seededOrder.id);
  order.status = 'refunded';
  const refunded = await route()
    .send({ orderId: seededOrder.id, email: 'guest@example.com', ...CHECKOUT_SHIPPING });
  assert.equal(refunded.status, 409);
  assert.equal(refunded.body.error, 'order_refunded');
  order.status = 'paid';

  const first = await route()
    .send({ orderId: seededOrder.id, email: 'Guest@Example.Com', ...CHECKOUT_SHIPPING, phone: '+212612345678' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { saved: true });
  const update = attempted.find(({ sql }) => sql.startsWith('UPDATE store_orders SET shipping_line1'));
  assert.ok(update, 'shipping update ran');
  assert.deepEqual(update.params.slice(0, 6), ['12 Silk Road', 'Riad wing', 'Casablanca', '20000', 'MA', '+212612345678']);

  const second = await route()
    .send({ orderId: seededOrder.id, email: 'guest@example.com', ...CHECKOUT_SHIPPING });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'shipping_already_set');
});
