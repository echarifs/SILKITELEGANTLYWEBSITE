import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupAuthState } from '../server/cleanup.js';

test('retention cleanup deletes only stale internal records in bounded batches', async () => {
  const queries = [];
  const pool = { query: async (sql) => { queries.push(sql); return [{ affectedRows: 0 }]; } };
  assert.equal(await cleanupAuthState(pool), 0);
  assert.equal(queries.length, 4);
  for (const sql of queries) {
    assert.match(sql, /LIMIT 500$/);
    assert.ok(!/DELETE FROM customers\b/u.test(sql));
    assert.match(sql, /DATE_SUB\(UTC_TIMESTAMP/u);
  }
});
