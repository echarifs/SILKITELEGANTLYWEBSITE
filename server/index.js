import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp, accountOrigins } from './app.js';
import { createPool } from './db.js';
import { createMailService } from './mail.js';
import { createSheetsService } from './sheets.js';
import { startAccountWorkers } from './workers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const development = process.argv.includes('--dev');
const pool = createPool();
const allowedOrigins = accountOrigins();
const mail = createMailService({ allowedOrigins });
const sheets = createSheetsService({ pool });
let vite;
let server;
let stopWorkers;

try {
  await pool.query('SELECT id FROM schema_migrations WHERE id = ? LIMIT 1', ['001-accounts']);
  await pool.query('SELECT id FROM auth_mail_jobs LIMIT 1');
  await pool.query('SELECT id FROM schema_migrations WHERE id = ? LIMIT 1', ['003-youcanpay-orders']);
  await pool.query('SELECT id FROM store_orders LIMIT 1');
  await pool.query('SELECT id FROM payment_mail_jobs LIMIT 1');
  await pool.query('SELECT address_line1 FROM customers LIMIT 1');
  const [emailResult, sheetResult] = await Promise.all([mail.verifyConnection(), sheets.verifyConnection()]);
  console.log('Email service:', emailResult.ok ? 'connected' : emailResult.code);
  console.log('Customer sheet:', sheetResult.ok ? 'connected and restricted' : sheetResult.code);
  const app = await createApp({ pool, mail, sheets, allowedOrigins });
  if (development) {
    const { createServer } = await import('vite');
    vite = await createServer({ root, server: { middlewareMode: true, host: '0.0.0.0' }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(root, 'dist'), { dotfiles: 'deny', index: 'index.html' }));
    app.get('/', (req, res) => res.sendFile(path.join(root, 'dist/index.html')));
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(500).json({ error: 'request_failed' });
  });
  const port = Number(process.env.PORT || 3000);
  server = app.listen(port, '0.0.0.0', () => console.log(`SilkItElegantly frontend and account API ready on port ${port}`));
  stopWorkers = startAccountWorkers({ pool, mail, allowedOrigins });
} catch {
  console.error('Website startup failed. Check database preparation and service configuration; secrets are not logged.');
  await pool.end();
  mail.close();
  process.exitCode = 1;
}

async function shutdown() {
  if (server) await new Promise(resolve => server.close(resolve));
  await vite?.close();
  await stopWorkers?.();
  mail.close();
  await pool.end();
}
process.once('SIGTERM', () => shutdown().then(() => process.exit(0)));
process.once('SIGINT', () => shutdown().then(() => process.exit(0)));
