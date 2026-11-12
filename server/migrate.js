import { createPool, migrate, migrateProfileAddress } from './db.js';
import { migrateMailQueue } from './mail-queue.js';
import { migrateRetentionIndexes } from './maintenance.js';
import { migratePayments } from './payments.js';
import { migratePaymentMailQueue } from './payment-mail-queue.js';

const pool = createPool();
try {
  await migrate(pool);
  await migrateProfileAddress(pool);
  await migrateMailQueue(pool);
  await migratePayments(pool);
  await migratePaymentMailQueue(pool);
  await migrateRetentionIndexes(pool);
  console.log('Account, payment, email-queue, and retention schemas are ready.');
} catch (error) {
  console.error('Account schema preparation failed. Check database access; no credential values are logged.');
  if (error?.code) console.error(`Database error code: ${error.code}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
