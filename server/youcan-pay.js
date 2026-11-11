import crypto from 'node:crypto';

export const YOUCANPAY_SANDBOX_TOKENIZE_URL = 'https://youcanpay.com/sandbox/api/tokenize';
const SANDBOX_PRIVATE_KEY = /^pri_sandbox_[A-Za-z0-9_-]{8,256}$/u;
const SANDBOX_PUBLIC_KEY = /^pub_sandbox_[A-Za-z0-9_-]{8,256}$/u;
const TRANSACTION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;

export function hasSandboxKeyPair(privateKey, publicKey) {
  return typeof privateKey === 'string'
    && typeof publicKey === 'string'
    && SANDBOX_PRIVATE_KEY.test(privateKey)
    && SANDBOX_PUBLIC_KEY.test(publicKey);
}

export async function createSandboxPaymentToken({
  orderId,
  amountMinor,
  currency,
  privateKey,
  publicKey,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!hasSandboxKeyPair(privateKey, publicKey)) throw new Error('PAYMENT_NOT_CONFIGURED');
  if (typeof orderId !== 'string' || !/^[a-f0-9-]{36}$/iu.test(orderId)) throw new Error('INVALID_ORDER');
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) throw new Error('INVALID_AMOUNT');
  if (!['EUR', 'MAD'].includes(currency)) throw new Error('INVALID_CURRENCY');
  if (typeof fetchImpl !== 'function') throw new Error('PAYMENT_PROVIDER_UNAVAILABLE');

  const body = new URLSearchParams({
    amount: String(amountMinor),
    currency,
    pri_key: privateKey,
    order_id: orderId,
  });
  let response;
  try {
    response = await fetchImpl(YOUCANPAY_SANDBOX_TOKENIZE_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('PAYMENT_PROVIDER_UNAVAILABLE');
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('PAYMENT_PROVIDER_UNAVAILABLE');
  }
  if (!response.ok) throw new Error('PAYMENT_PROVIDER_REJECTED');

  const token = typeof result?.token === 'string' ? result.token : result?.token?.id;
  const transactionId = result?.transaction_id;
  if (typeof token !== 'string' || token.length < 4 || token.length > 512
      || (transactionId !== undefined && transactionId !== null
        && (typeof transactionId !== 'string' || !TRANSACTION_ID.test(transactionId)))) {
    throw new Error('PAYMENT_PROVIDER_UNAVAILABLE');
  }
  return { token, transactionId: transactionId || null };
}

export function verifyYouCanPaySignature(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string' || typeof secret !== 'string' || !secret) return false;
  const supplied = signature.trim();
  if (!/^[a-f0-9]{64}$/iu.test(supplied)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(supplied, 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(expected, received);
}

export function parseYouCanPayMinorAmount(value, currency) {
  if (!['EUR', 'MAD'].includes(currency)) return null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && /^\d{1,15}$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  if (value && typeof value === 'object' && typeof value.amount === 'string') {
    const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/u.exec(value.amount);
    if (!match) return null;
    const minor = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
    return Number.isSafeInteger(minor) ? minor : null;
  }
  return null;
}
