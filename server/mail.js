import nodemailer from 'nodemailer';
import addressParser from 'nodemailer/lib/addressparser/index.js';

export function createMailService({ smtpUrl = process.env.SMTP_URL, resendApiKey = process.env.RESEND_API_KEY, mailFrom = process.env.MAIL_FROM, allowedOrigins = new Set() } = {}) {
  let transport = null;
  let apiKey = '';
  let ready = false;
  let sender = '';
  const apiRequested = Boolean(resendApiKey);
  if (apiRequested) {
    try {
      const key = String(resendApiKey).trim();
      if (!/^re_[A-Za-z0-9_-]{8,}$/u.test(key)) throw new Error('INVALID_API_KEY');
      sender = displaySender(mailFrom);
      apiKey = key;
    } catch {
      apiKey = '';
      sender = '';
    }
  } else {
    try {
      const url = new URL(smtpUrl);
      if (!['smtp:', 'smtps:'].includes(url.protocol) || !url.hostname || !url.username || !url.password) throw new Error('INVALID_SMTP');
      const authenticatedMailbox = decodeURIComponent(url.username);
      sender = authenticatedMailboxFromSmtpUrl(url);
      transport = nodemailer.createTransport({
        host: url.hostname,
        port: Number(url.port || (url.protocol === 'smtps:' ? 465 : 587)),
        secure: url.protocol === 'smtps:',
        requireTLS: url.protocol !== 'smtps:',
        auth: { user: authenticatedMailbox, pass: decodeURIComponent(url.password) },
        tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
        connectionTimeout: 12000,
        greetingTimeout: 12000,
        socketTimeout: 20000,
        logger: false,
        debug: false,
      });
    } catch {
      transport = null;
    }
  }

  async function verifyConnection() {
    ready = false;
    if (apiRequested) {
      if (!apiKey) return { ok: false, code: 'EMAIL_CONFIGURATION_INVALID' };
      return verifyApi();
    }
    if (!transport) return { ok: false, code: 'SMTP_CONFIGURATION_INVALID' };
    try {
      await transport.verify();
      ready = true;
      return { ok: true };
    } catch (error) {
      return { ok: false, code: error?.code === 'EAUTH' ? 'SMTP_AUTHENTICATION_FAILED' : 'SMTP_CONNECTION_FAILED' };
    }
  }

  async function verifyApi() {
    try {
      const response = await fetch('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(12000),
      });
      if (response.status === 401 || response.status === 403) return { ok: false, code: 'EMAIL_API_AUTHENTICATION_FAILED' };
      if (!response.ok) return { ok: false, code: 'EMAIL_API_UNAVAILABLE' };
      const payload = await response.json().catch(() => null);
      const domain = senderAddress(sender).split('@')[1]?.toLowerCase();
      const verified = Array.isArray(payload?.data)
        && payload.data.some((entry) => String(entry?.name || '').toLowerCase() === domain && entry?.status === 'verified');
      if (!verified) return { ok: false, code: 'EMAIL_DOMAIN_UNVERIFIED' };
      ready = true;
      return { ok: true };
    } catch {
      return { ok: false, code: 'EMAIL_API_UNAVAILABLE' };
    }
  }

  async function deliver(message) {
    if (!apiKey) {
      return sendMailSafely(transport, { from: sender, ...message, disableFileAccess: true, disableUrlAccess: true });
    }
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: sender, to: message.to, subject: message.subject, text: message.text }),
        signal: AbortSignal.timeout(20000),
      });
      if (response.ok) return;
      const error = new Error('EMAIL_DELIVERY_FAILED');
      error.code = response.status === 401 || response.status === 403 ? 'EMAIL_API_AUTHENTICATION_FAILED'
        : response.status === 429 ? 'EMAIL_API_RATE_LIMITED'
          : response.status >= 500 ? 'EMAIL_API_UNAVAILABLE'
            : 'EMAIL_API_REJECTED';
      throw error;
    } catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('EMAIL_')) throw error;
      const safeError = new Error('EMAIL_DELIVERY_FAILED');
      safeError.code = 'EMAIL_API_UNAVAILABLE';
      throw safeError;
    }
  }

  async function send({ email, name, token, origin }, mode) {
    if (!ready) throw new Error('EMAIL_UNAVAILABLE');
    if (!allowedOrigins.has(origin) || !/^[a-f0-9]{64}$/u.test(token)) throw new Error('INVALID_EMAIL_REQUEST');
    const link = `${origin}/#${mode}?token=${token}`;
    const verification = mode === 'verify-email';
    const subject = verification ? 'Verify your SilkItElegantly account' : 'Reset your SilkItElegantly password';
    const greeting = String(name || '').replace(/[\r\n]/gu, ' ').slice(0, 128);
    const explanation = verification
      ? 'Confirm your email and enter the password you chose when registering. Opening this link alone does not verify your account.'
      : 'Choose a new password using this one-time link. Completing the reset signs out existing sessions.';
    const text = `Hello ${greeting},\n\n${explanation}\n\n${link}\n\nThis link expires in 30 minutes. If you did not request it, do not use it. You can safely ignore this email; it does not sign you in.\n\nSilkItElegantly`;
    await deliver({ to: email, subject, text });
  }

  async function sendOrderNotice({ email, name, orderId, amountMinor, currency, transactionId, refundAmountMinor = null }, type) {
    if (!ready) throw new Error('EMAIL_UNAVAILABLE');
    if (typeof email !== 'string' || email.length > 254 || /[\r\n\s]/u.test(email)
        || typeof orderId !== 'string' || !/^[a-f0-9-]{36}$/iu.test(orderId)
        || !Number.isSafeInteger(amountMinor) || amountMinor < 1 || !['EUR', 'MAD'].includes(currency)) {
      throw new Error('INVALID_ORDER_EMAIL');
    }
    const safeName = String(name || '').replace(/[\r\n]/gu, ' ').slice(0, 128);
    const safeReference = String(transactionId || '').replace(/[\r\n]/gu, '').slice(0, 128);
    const orderReference = orderId.replace(/-/gu, '').slice(0, 10).toUpperCase();
    const total = new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amountMinor / 100);
    if (refundAmountMinor !== null && (!Number.isSafeInteger(refundAmountMinor) || refundAmountMinor < 1 || refundAmountMinor > amountMinor)) {
      throw new Error('INVALID_REFUND_EMAIL');
    }
    const refundTotal = refundAmountMinor === null
      ? null
      : new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(refundAmountMinor / 100);
    const paymentConfirmation = type === 'payment_confirmation';
    const subject = paymentConfirmation
      ? `Payment confirmed for order ${orderReference}`
      : `Refund update for order ${orderReference}`;
    const text = paymentConfirmation
      ? `Hello ${safeName},\n\nYour sandbox card payment has been confirmed for order ${orderReference}.\nTotal: ${total}\nYouCan Pay transaction reference: ${safeReference}\n\nSilkItElegantly`
      : `Hello ${safeName},\n\nA refund update has been received for order ${orderReference}.${refundTotal ? `\nRefund amount recorded: ${refundTotal}.` : ''}\nPlease allow your bank's normal processing time for the refund to appear.\nYouCan Pay transaction reference: ${safeReference}\n\nSilkItElegantly`;
    await deliver({ to: email, subject, text });
  }

  return {
    get configured() { return ready; },
    verifyConnection,
    sendVerification: (input) => send(input, 'verify-email'),
    sendPasswordReset: (input) => send(input, 'reset-password'),
    sendPaymentConfirmation: (input) => sendOrderNotice(input, 'payment_confirmation'),
    sendRefundNotification: (input) => sendOrderNotice(input, 'refund_notification'),
    close() { transport?.close(); },
  };
}

const SAFE_SMTP_FAILURES = new Set(['SMTP_SEND_FAILED', 'SMTP_AUTHENTICATION_FAILED', 'SMTP_CONNECTION_FAILED', 'SMTP_REJECTED', 'SMTP_TEMPORARY_FAILURE']);
const SMTP_NETWORK_ERROR_CODES = new Set(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN', 'ETLS']);

export function classifySmtpFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (SAFE_SMTP_FAILURES.has(code)) return code;
  if (code === 'EAUTH') return 'SMTP_AUTHENTICATION_FAILED';
  if (SMTP_NETWORK_ERROR_CODES.has(code)) return 'SMTP_CONNECTION_FAILED';
  const responseCode = Number(error?.responseCode);
  if (responseCode >= 500 && responseCode < 600) return 'SMTP_REJECTED';
  if (responseCode >= 400 && responseCode < 500) return 'SMTP_TEMPORARY_FAILURE';
  if (code === 'EENVELOPE' || code === 'EMESSAGE') return 'SMTP_REJECTED';
  return 'SMTP_SEND_FAILED';
}

async function sendMailSafely(transport, message) {
  try {
    const result = await transport.sendMail(message);
    if (!result?.accepted?.length || result.rejected?.length) {
      const error = new Error('EMAIL_REJECTED');
      error.code = 'EENVELOPE';
      throw error;
    }
  } catch (error) {
    const safeError = new Error('EMAIL_DELIVERY_FAILED');
    safeError.code = classifySmtpFailure(error);
    throw safeError;
  }
}

export function senderAddress(value) {
  const parsed = addressParser(String(value || '').trim());
  return parsed.length === 1 ? String(parsed[0].address || '') : '';
}

export function displaySender(value) {
  const text = String(value || '').trim();
  if (!text || /[\r\n]/u.test(text)) throw new Error('INVALID_SENDER');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(senderAddress(text))) throw new Error('INVALID_SENDER');
  return text;
}

export function authenticatedMailboxFromSmtpUrl(smtpUrl) {
  const url = smtpUrl instanceof URL ? smtpUrl : new URL(smtpUrl);
  const mailbox = decodeURIComponent(url.username || '');
  if (/[\r\n]/u.test(mailbox)) throw new Error('INVALID_SENDER');
  const senders = addressParser(mailbox);
  if (senders.length !== 1 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(senders[0].address || '')) throw new Error('INVALID_SENDER');
  return senders[0].address;
}
