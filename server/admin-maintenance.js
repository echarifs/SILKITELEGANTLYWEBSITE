import { createPool } from './db.js';
import { accountOrigins } from './app.js';
import { createMailService } from './mail.js';
import { processAccountMail } from './mail-queue.js';
import { cleanupAuthState } from './cleanup.js';

const pool = createPool();
const origins = accountOrigins();
const mail = createMailService({ allowedOrigins: origins });
try {
  if (process.argv.includes('--mail')) {
    const check = await mail.verifyConnection();
    if (!check.ok) throw new Error('EMAIL_UNAVAILABLE');
    await processAccountMail(pool, mail, { allowedOrigins: origins, batchSize: 5 });
    console.log('Bounded account-email retry completed.');
  } else {
    const removed = await cleanupAuthState(pool);
    console.log(`Removed ${removed} stale internal authentication records; customer profiles are unchanged.`);
  }
} catch {
  console.error('Account maintenance could not complete. Check service configuration.');
  process.exitCode = 1;
} finally {
  mail.close();
  await pool.end();
}
