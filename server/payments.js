import crypto from 'node:crypto';
import express from 'express';
import {
  MAX_JSON_BYTES,
  clientAddress,
  hashToken,
  isAllowedOrigin,
  isJsonRequest,
  normalizeEmail,
  requestOrigin,
  setSecurityHeaders,
  validateCountry,
  validateName,
  validateOptionalAddressLine,
  validatePhone,
  validBodyObject,
} from './security.js';
import { productCatalog } from '../src/product-catalog.js';
import {
  createSandboxPaymentToken,
  hasSandboxKeyPair,
  parseYouCanPayMinorAmount,
  verifyYouCanPaySignature,
} from './youcan-pay.js';
import { enqueuePaymentEmail } from './payment-mail-queue.js';

export const PAYMENTS_MIGRATION_ID = '003-youcanpay-orders';
const CURRENCY = 'EUR';
const RATE_WINDOW_MS = 15 * 60 * 1000;
const UUID_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;

export async function migratePayments(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A MySQL pool is required');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store_orders (
      id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      status VARCHAR(24) NOT NULL DEFAULT 'pending_payment',
      customer_name VARCHAR(128) NOT NULL,
      customer_email VARCHAR(254) NOT NULL,
      customer_phone VARCHAR(40) NULL,
      items_json JSON NOT NULL,
      currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      amount_minor BIGINT UNSIGNED NOT NULL,
      provider VARCHAR(32) NOT NULL DEFAULT 'youcanpay',
      provider_mode VARCHAR(8) NOT NULL DEFAULT 'sandbox',
      provider_transaction_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
      refund_amount_minor BIGINT UNSIGNED NULL,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      paid_at DATETIME(3) NULL,
      refunded_at DATETIME(3) NULL,
      shipping_line1 VARCHAR(200) NULL,
      shipping_line2 VARCHAR(200) NULL,
      shipping_city VARCHAR(120) NULL,
      shipping_postal_code VARCHAR(20) NULL,
      shipping_country CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NULL,
      shipping_set_at DATETIME(3) NULL,
      CONSTRAINT store_orders_status_chk CHECK (status IN ('pending_payment', 'paid', 'payment_failed', 'partially_refunded', 'refunded')),
      CONSTRAINT store_orders_sandbox_chk CHECK (provider_mode = 'sandbox'),
      CONSTRAINT store_orders_amount_chk CHECK (amount_minor > 0),
      UNIQUE KEY store_orders_provider_txn_unique (provider_transaction_id),
      KEY store_orders_email_created_idx (customer_email, created_at),
      KEY store_orders_status_created_idx (status, created_at)
    ) ENGINE=InnoDB`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_webhook_events (
      event_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      event_name VARCHAR(64) NOT NULL,
      order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
      processing_status VARCHAR(16) NOT NULL DEFAULT 'received',
      received_at DATETIME(3) NOT NULL,
      CONSTRAINT payment_webhook_status_chk CHECK (processing_status IN ('received', 'processed', 'ignored', 'rejected')),
      KEY payment_webhook_order_idx (order_id, received_at)
    ) ENGINE=InnoDB`);
  await pool.query('INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES (?, UTC_TIMESTAMP(3))', [PAYMENTS_MIGRATION_ID]);
  return PAYMENTS_MIGRATION_ID;
}

export const ORDER_SHIPPING_MIGRATION_ID = '006-order-shipping';

const SHIPPING_COLUMN_DEFS = [
  ['shipping_line1', 'shipping_line1 VARCHAR(200) NULL'],
  ['shipping_line2', 'shipping_line2 VARCHAR(200) NULL'],
  ['shipping_city', 'shipping_city VARCHAR(120) NULL'],
  ['shipping_postal_code', 'shipping_postal_code VARCHAR(20) NULL'],
  ['shipping_country', 'shipping_country CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NULL'],
  ['shipping_set_at', 'shipping_set_at DATETIME(3) NULL'],
];

export async function migrateOrderShipping(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A MySQL pool is required');
  const [applied] = await pool.query('SELECT id FROM schema_migrations WHERE id = ? LIMIT 1', [ORDER_SHIPPING_MIGRATION_ID]);
  if (applied.length === 0) {
    for (const [column, definition] of SHIPPING_COLUMN_DEFS) {
      const [existing] = await pool.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'store_orders' AND COLUMN_NAME = ?`,
        [column],
      );
      if (existing.length === 0) await pool.query(`ALTER TABLE store_orders ADD COLUMN ${definition}`);
    }
  }
  await pool.query('INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES (?, UTC_TIMESTAMP(3))', [ORDER_SHIPPING_MIGRATION_ID]);
  return ORDER_SHIPPING_MIGRATION_ID;
}

export function buildTrustedOrder(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 20) throw new Error('INVALID_CART');
  const lines = [];
  let amountMinor = 0;
  for (const entry of items) {
    if (!validBodyObject(entry) || typeof entry.productId !== 'string' || typeof entry.option !== 'string'
        || !Number.isInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > 99) {
      throw new Error('INVALID_CART');
    }
    const product = productCatalog[entry.productId];
    const variant = product?.priceOptions.find((candidate) => candidate.option === entry.option);
    if (!product || !variant) throw new Error('INVALID_CART');
    const unitAmountMinor = variant.price * 100;
    const lineAmountMinor = unitAmountMinor * entry.quantity;
    amountMinor += lineAmountMinor;
    if (!Number.isSafeInteger(amountMinor)) throw new Error('INVALID_CART');
    lines.push({
      productId: entry.productId,
      productName: product.name,
      option: variant.option,
      quantity: entry.quantity,
      unitAmountMinor,
      lineAmountMinor,
    });
  }
  if (amountMinor < 1) throw new Error('INVALID_CART');
  return { currency: CURRENCY, amountMinor, lines };
}

async function transaction(pool, work) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch { /* preserve the original error */ }
    throw error;
  } finally {
    connection.release();
  }
}

async function allowRate(pool, key, limit) {
  return transaction(pool, async (connection) => {
    await connection.query(
      'INSERT IGNORE INTO auth_rate_limits (bucket_key, window_started_at, attempts, blocked_until) VALUES (?, UTC_TIMESTAMP(3), 0, NULL)',
      [key],
    );
    const [rows] = await connection.query('SELECT * FROM auth_rate_limits WHERE bucket_key = ? LIMIT 1 FOR UPDATE', [key]);
    const row = rows[0];
    if (!row) return false;
    const now = Date.now();
    const start = new Date(row.window_started_at).getTime();
    if (row.blocked_until && new Date(row.blocked_until).getTime() > now) return false;
    if (!Number.isFinite(start) || now - start >= RATE_WINDOW_MS) {
      await connection.query(
        'UPDATE auth_rate_limits SET window_started_at = UTC_TIMESTAMP(3), attempts = 1, blocked_until = NULL WHERE bucket_key = ?',
        [key],
      );
      return true;
    }
    const attempts = Number(row.attempts || 0) + 1;
    const over = attempts > limit;
    await connection.query(
      'UPDATE auth_rate_limits SET attempts = ?, blocked_until = ? WHERE bucket_key = ?',
      [attempts, over ? new Date(now + RATE_WINDOW_MS) : null, key],
    );
    return !over;
  });
}

async function checkoutRateAllowed(pool, req, email) {
  const ipKey = `rate:checkout:ip:${hashToken(clientAddress(req)).toString('hex')}`;
  if (!await allowRate(pool, ipKey, 8)) return false;
  const emailKey = `rate:checkout:email:${hashToken(email).toString('hex')}`;
  return allowRate(pool, emailKey, 5);
}

function normalizedOrigins(allowedOrigins) {
  const result = new Set();
  const candidates = allowedOrigins instanceof Set || Array.isArray(allowedOrigins) ? allowedOrigins : [];
  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    try { result.add(new URL(value).origin); } catch { /* ignore invalid configured origin */ }
  }
  return result;
}

/** Optional shipping block: null = not supplied, undefined = invalid. */
function shippingFromBody(value) {
  if (value === undefined || value === null) return null;
  if (!validBodyObject(value)) return undefined;
  const line1 = validateOptionalAddressLine(value.line1);
  const line2 = validateOptionalAddressLine(value.line2);
  const city = validateOptionalAddressLine(value.city, 120);
  const postalCode = validateOptionalAddressLine(value.postalCode, 20);
  const country = validateCountry(value.country);
  if (line1 === undefined || line2 === undefined || city === undefined
      || postalCode === undefined || country === undefined) return undefined;
  // A delivered parcel needs a street, city, postal code, and country.
  if (!line1 || !city || !postalCode || !country) return undefined;
  return { line1, line2, city, postalCode, country };
}

function shippingRateKey(kind, value) {
  return `rate:shipping:${kind}:${hashToken(value).toString('hex')}`;
}

export function createPaymentsRouter({
  pool,
  allowedOrigins = new Set(),
  privateKey = process.env.YOUCANPAY_SANDBOX_PRIVATE_KEY,
  publicKey = process.env.YOUCANPAY_SANDBOX_PUBLIC_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.getConnection !== 'function') throw new TypeError('pool is required');
  const router = express.Router();
  const origins = normalizedOrigins(allowedOrigins);
  router.use((_req, res, next) => { setSecurityHeaders(res); next(); });
  router.use(express.json({ limit: MAX_JSON_BYTES, type: 'application/json' }));

  router.post('/checkout', async (req, res, next) => {
    try {
      if (!isAllowedOrigin(requestOrigin(req), origins)) return res.status(403).json({ error: 'request_not_authorized' });
      if (!isJsonRequest(req)) return res.status(415).json({ error: 'json_required' });
      if (!hasSandboxKeyPair(privateKey, publicKey)) return res.status(503).json({ error: 'sandbox_payments_not_configured' });
      if (!validBodyObject(req.body) || !validBodyObject(req.body.customer)) return res.status(400).json({ error: 'invalid_checkout' });
      const name = validateName(req.body.customer.name);
      const email = normalizeEmail(req.body.customer.email);
      const phone = validatePhone(req.body.customer.phone);
      if (!name || !email || phone === undefined) return res.status(400).json({ error: 'invalid_checkout' });
      const shipping = shippingFromBody(req.body.shipping);
      if (shipping === undefined) return res.status(400).json({ error: 'invalid_checkout' });
      if (!await checkoutRateAllowed(pool, req, email)) return res.status(429).json({ error: 'try_again_later' });

      let order;
      try { order = buildTrustedOrder(req.body.items); }
      catch { return res.status(400).json({ error: 'invalid_cart' }); }

      const orderId = crypto.randomUUID();
      const shippingAt = shipping ? 'UTC_TIMESTAMP(3)' : 'NULL';
      await pool.query(`
        INSERT INTO store_orders
          (id, status, customer_name, customer_email, customer_phone, items_json, currency, amount_minor, provider, provider_mode,
           shipping_line1, shipping_line2, shipping_city, shipping_postal_code, shipping_country, shipping_set_at,
           created_at, updated_at)
        VALUES (?, 'pending_payment', ?, ?, ?, ?, ?, ?, 'youcanpay', 'sandbox', ?, ?, ?, ?, ?, ${shippingAt}, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`, [
        orderId, name, email, phone, JSON.stringify(order.lines), order.currency, order.amountMinor,
        shipping?.line1 ?? null, shipping?.line2 ?? null, shipping?.city ?? null, shipping?.postalCode ?? null, shipping?.country ?? null,
      ]);

      let providerToken;
      try {
        providerToken = await createSandboxPaymentToken({
          orderId,
          amountMinor: order.amountMinor,
          currency: order.currency,
          privateKey,
          publicKey,
          fetchImpl,
        });
      } catch {
        await pool.query("UPDATE store_orders SET status = 'payment_failed', updated_at = UTC_TIMESTAMP(3) WHERE id = ?", [orderId]);
        return res.status(502).json({ error: 'payment_provider_unavailable' });
      }

      await pool.query(`
        UPDATE store_orders
           SET provider_transaction_id = ?, updated_at = UTC_TIMESTAMP(3)
         WHERE id = ? AND status = 'pending_payment'`, [providerToken.transactionId, orderId]);
      res.status(201).json({
        orderId,
        orderReference: orderId.replace(/-/gu, '').slice(0, 10).toUpperCase(),
        amountMinor: order.amountMinor,
        currency: order.currency,
        token: providerToken.token,
        publicKey,
        mode: 'sandbox',
      });
    } catch (error) { next(error); }
  });

  // Delivery details captured right after payment. Public like /checkout, but
  // gated by the unguessable order id plus the payer's email; idempotent once
  // shipping_set_at is written.
  router.post('/shipping-details', async (req, res, next) => {
    try {
      if (!isAllowedOrigin(requestOrigin(req), origins)) return res.status(403).json({ error: 'request_not_authorized' });
      if (!isJsonRequest(req)) return res.status(415).json({ error: 'json_required' });
      if (!validBodyObject(req.body)) return res.status(400).json({ error: 'invalid_shipping' });
      const orderId = typeof req.body.orderId === 'string' && UUID_RE.test(req.body.orderId) ? req.body.orderId : '';
      const email = normalizeEmail(req.body.email);
      if (!orderId || !email) return res.status(400).json({ error: 'invalid_shipping' });
      if (!await allowRate(pool, shippingRateKey('ip', clientAddress(req)), 8)
          || !await allowRate(pool, shippingRateKey('order', orderId), 6)) {
        return res.status(429).json({ error: 'try_again_later' });
      }
      const shipping = shippingFromBody({
        line1: req.body.line1,
        line2: req.body.line2,
        city: req.body.city,
        postalCode: req.body.postalCode,
        country: req.body.country,
      });
      if (!shipping) return res.status(400).json({ error: 'invalid_shipping' });
      let shippingPhone = null;
      if (req.body.phone !== undefined && req.body.phone !== null && req.body.phone !== '') {
        shippingPhone = validatePhone(req.body.phone);
        if (shippingPhone === undefined) return res.status(400).json({ error: 'invalid_shipping' });
        shippingPhone = shippingPhone || null;
      }
      const [orders] = await pool.query(
        'SELECT customer_email, status, shipping_set_at FROM store_orders WHERE id = ? LIMIT 1',
        [orderId],
      );
      const order = orders[0];
      if (!order || String(order.customer_email).toLowerCase() !== email) return res.status(404).json({ error: 'order_not_found' });
      if (order.shipping_set_at) return res.status(409).json({ error: 'shipping_already_set' });
      if (order.status === 'refunded' || order.status === 'partially_refunded') return res.status(409).json({ error: 'order_refunded' });
      const [result] = await pool.query(`
        UPDATE store_orders
           SET shipping_line1 = ?, shipping_line2 = ?, shipping_city = ?, shipping_postal_code = ?, shipping_country = ?,
               customer_phone = COALESCE(customer_phone, ?), shipping_set_at = UTC_TIMESTAMP(3), updated_at = UTC_TIMESTAMP(3)
         WHERE id = ? AND shipping_set_at IS NULL`, [
        shipping.line1, shipping.line2, shipping.city, shipping.postalCode, shipping.country, shippingPhone, orderId,
      ]);
      if (result.affectedRows === 0) return res.status(409).json({ error: 'shipping_already_set' });
      return res.status(200).json({ saved: true });
    } catch (error) { next(error); }
  });
  return router;
}

function validProviderEvent(event) {
  return event && typeof event === 'object' && !Array.isArray(event)
    && typeof event.id === 'string' && UUID_RE.test(event.id)
    && ['transaction.paid', 'transaction.failed', 'transaction.refunded'].includes(event.event_name)
    && event.sandbox === true
    && event.payload && typeof event.payload === 'object'
    && event.payload.transaction && typeof event.payload.transaction === 'object';
}

export async function applyProviderEvent(pool, event) {
  const tx = event.payload.transaction;
  const currency = typeof tx.currency === 'string' ? tx.currency : tx.amount?.currency;
  const amountMinor = parseYouCanPayMinorAmount(tx.amount, currency);
  const orderId = typeof tx.order_id === 'string' ? tx.order_id : '';
  const transactionId = typeof tx.id === 'string' ? tx.id : '';
  return transaction(pool, async (connection) => {
    const [insertResult] = await connection.query(`
      INSERT IGNORE INTO payment_webhook_events (event_id, event_name, order_id, processing_status, received_at)
      VALUES (?, ?, ?, 'received', UTC_TIMESTAMP(3))`, [event.id, event.event_name, /^[a-f0-9-]{36}$/iu.test(orderId) ? orderId : null]);
    if (Number(insertResult.affectedRows) === 0) return 'duplicate';
    if (!UUID_RE.test(orderId) || !UUID_RE.test(transactionId) || amountMinor === null || currency !== CURRENCY) {
      await connection.query("UPDATE payment_webhook_events SET processing_status = 'rejected' WHERE event_id = ?", [event.id]);
      return 'rejected';
    }
    const [orders] = await connection.query('SELECT * FROM store_orders WHERE id = ? LIMIT 1 FOR UPDATE', [orderId]);
    const order = orders[0];
    if (!order || order.provider_mode !== 'sandbox'
        || (order.provider_transaction_id && order.provider_transaction_id !== transactionId)
        || order.currency !== currency || Number(order.amount_minor) !== amountMinor) {
      await connection.query("UPDATE payment_webhook_events SET processing_status = 'rejected' WHERE event_id = ?", [event.id]);
      return 'rejected';
    }

    if (!order.provider_transaction_id) {
      await connection.query(
        'UPDATE store_orders SET provider_transaction_id = ? WHERE id = ? AND provider_transaction_id IS NULL',
        [transactionId, orderId],
      );
      order.provider_transaction_id = transactionId;
    }

    if (event.event_name === 'transaction.paid') {
      if (order.status !== 'refunded' && order.status !== 'partially_refunded') {
        const changed = order.status !== 'paid';
        await connection.query(`
          UPDATE store_orders
             SET status = 'paid', paid_at = COALESCE(paid_at, UTC_TIMESTAMP(3)), updated_at = UTC_TIMESTAMP(3)
           WHERE id = ?`, [orderId]);
        if (changed) await enqueuePaymentEmail(connection, { orderId, webhookEventId: event.id, type: 'payment_confirmation' });
      }
    } else if (event.event_name === 'transaction.failed') {
      if (order.status === 'pending_payment') {
        await connection.query("UPDATE store_orders SET status = 'payment_failed', updated_at = UTC_TIMESTAMP(3) WHERE id = ?", [orderId]);
      }
    } else if (event.event_name === 'transaction.refunded') {
      if (!['paid', 'partially_refunded'].includes(order.status)) {
        await connection.query("UPDATE payment_webhook_events SET processing_status = 'ignored' WHERE event_id = ?", [event.id]);
        return 'ignored';
      }
      const refundedMinor = parseYouCanPayMinorAmount(tx.amount_refunded, currency);
      const orderAmountMinor = Number(order.amount_minor);
      if (refundedMinor !== null && (refundedMinor < 1 || refundedMinor > orderAmountMinor)) {
        await connection.query("UPDATE payment_webhook_events SET processing_status = 'rejected' WHERE event_id = ?", [event.id]);
        return 'rejected';
      }
      const fullyRefunded = tx.is_fully_refunded === true
        || tx.status === 'refunded'
        || (refundedMinor !== null && refundedMinor >= orderAmountMinor);
      const partiallyRefunded = tx.is_fully_refunded === false
        || tx.status === 'paid'
        || (refundedMinor !== null && refundedMinor < orderAmountMinor);
      if (!fullyRefunded && !partiallyRefunded) {
        await connection.query("UPDATE payment_webhook_events SET processing_status = 'ignored' WHERE event_id = ?", [event.id]);
        return 'ignored';
      }
      const status = fullyRefunded ? 'refunded' : 'partially_refunded';
      const recordedRefundMinor = fullyRefunded ? (refundedMinor ?? orderAmountMinor) : refundedMinor;
      await connection.query(`
        UPDATE store_orders
           SET status = ?, refund_amount_minor = COALESCE(?, refund_amount_minor),
               refunded_at = COALESCE(refunded_at, UTC_TIMESTAMP(3)), updated_at = UTC_TIMESTAMP(3)
         WHERE id = ?`, [status, recordedRefundMinor, orderId]);
      await enqueuePaymentEmail(connection, { orderId, webhookEventId: event.id, type: 'refund_notification' });
    }
    await connection.query("UPDATE payment_webhook_events SET processing_status = 'processed' WHERE event_id = ?", [event.id]);
    return 'processed';
  });
}

export function createYouCanPayWebhookHandler({
  pool,
  privateKey = process.env.YOUCANPAY_SANDBOX_PRIVATE_KEY,
  publicKey = process.env.YOUCANPAY_SANDBOX_PUBLIC_KEY,
} = {}) {
  if (!pool || typeof pool.getConnection !== 'function') throw new TypeError('pool is required');
  return async (req, res) => {
    const rawBody = req.body;
    const signature = req.headers['x-youcanpay-signature'];
    if (!Buffer.isBuffer(rawBody)) return res.status(400).json({ error: 'invalid_webhook' });
    if (!hasSandboxKeyPair(privateKey, publicKey)) return res.status(503).json({ error: 'webhook_not_configured' });
    if (!verifyYouCanPaySignature(rawBody, signature, privateKey)) return res.status(403).json({ error: 'invalid_signature' });
    let event;
    try { event = JSON.parse(rawBody.toString('utf8')); }
    catch { return res.status(400).json({ error: 'invalid_webhook' }); }
    if (!validProviderEvent(event)) return res.status(204).end();
    try {
      await applyProviderEvent(pool, event);
      return res.status(200).json({ received: true });
    } catch {
      return res.status(500).json({ error: 'webhook_processing_failed' });
    }
  };
}
