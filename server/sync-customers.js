import { createPool } from './db.js';
import { createSheetsService } from './sheets.js';

const pool = createPool();
const sheets = createSheetsService({ pool });
try {
  const connection = await sheets.verifyConnection();
  if (!connection.ok) throw new Error('SHEET_UNAVAILABLE');
  const [customers] = await pool.query("SELECT id FROM customers WHERE verified_at IS NOT NULL AND sheet_sync_status IN ('pending', 'failed') ORDER BY created_at LIMIT 100");
  let synced = 0;
  let failed = 0;
  for (const customer of customers) {
    try {
      await sheets.syncCustomer(customer.id);
      synced += 1;
    } catch {
      failed += 1;
      await pool.query("UPDATE customers SET sheet_sync_status = 'failed', sheet_sync_error = 'SYNC_FAILED', sheet_sync_attempted_at = UTC_TIMESTAMP(3) WHERE id = ?", [customer.id]);
    }
  }
  console.log(`Customer directory retry finished: ${synced} synced, ${failed} pending attention.`);
  if (failed) process.exitCode = 1;
} catch {
  console.error('Customer directory retry unavailable. Check private sharing and service credentials.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
