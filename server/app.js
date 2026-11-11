import express from 'express';
import helmet from 'helmet';
import { createAuthRouter } from './auth.js';
import { createPaymentsRouter, createYouCanPayWebhookHandler } from './payments.js';

const PRODUCTION_APP_ORIGIN = 'https://silkitelegantly.com';

export function accountOrigins({ development = process.argv.includes('--dev'), port = Number(process.env.PORT || 3000) } = {}) {
  const values = [
    PRODUCTION_APP_ORIGIN,
    'https://www.silkitelegantly.com',
    ...(process.env.PUBLIC_APP_ORIGIN || '').split(','),
  ];
  const allowed = new Set();
  for (const value of values) {
    try {
      const url = new URL(value.trim());
      if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) allowed.add(url.origin);
    } catch { /* invalid origins are not trusted */ }
  }
  // The Preview proxy rewrites the browser Origin to the internal dev listener.
  // Trust only these exact loopback origins in development, never in production.
  if (development && Number.isInteger(port) && port >= 1024 && port <= 65535) {
    allowed.add(`http://127.0.0.1:${port}`);
    allowed.add(`http://localhost:${port}`);
  }
  return allowed;
}

export function resolvePublicAppOrigin({ development = process.argv.includes('--dev'), allowedOrigins = accountOrigins({ development }) } = {}) {
  const configured = (process.env.PUBLIC_APP_ORIGIN || '').split(',');
  for (const candidate of [...configured, PRODUCTION_APP_ORIGIN]) {
    try {
      const url = new URL(candidate.trim());
      if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash && allowedOrigins.has(url.origin)) {
        return url.origin;
      }
    } catch { /* invalid public origins are not trusted */ }
  }
  return null;
}

export async function createApp({ pool, mail, sheets, allowedOrigins = accountOrigins(), publicOrigin } = {}) {
  const resolvedPublicOrigin = publicOrigin === undefined ? resolvePublicAppOrigin({ allowedOrigins }) : publicOrigin;
  const app = express();
  app.disable('x-powered-by');
  // Managed traffic reaches the app through one trusted ingress proxy. If moving to
  // another host, review this setting rather than trusting arbitrary forwarding headers.
  app.set('trust proxy', 1);
  app.use(helmet({
    frameguard: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://youcanpay.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        mediaSrc: ["'self'"],
        connectSrc: ["'self'", 'https://youcanpay.com', 'ws:', 'wss:'],
        frameSrc: ["'self'", 'https://youcanpay.com'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'", 'https://youcanpay.com'],
        // Do not restrict frame ancestors: HTTPS Preview is a cross-site iframe.
      },
    },
  }));
  app.post('/api/webhooks/youcan-pay', express.raw({ type: 'application/json', limit: '64kb' }), createYouCanPayWebhookHandler({ pool }));
  app.use('/api/payments', createPaymentsRouter({ pool, allowedOrigins }));
  app.use('/api/auth', await createAuthRouter({ pool, mail, sheets, allowedOrigins, publicOrigin: resolvedPublicOrigin }));
  app.get('/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.status(200).json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'database_unavailable' });
    }
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
  return app;
}
