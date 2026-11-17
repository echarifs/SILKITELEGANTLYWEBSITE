import { JWT } from 'google-auth-library';
import { assertPrivatePermissions, chooseCustomerRow } from './sheets.js';

export const ORDERS_SHEET_ID = '1fPc0toqXfTqgxPi2oztW4MSumAXhwYjxQCZb42Hx1k8';
export const ORDER_TAB = 'Orders';
export const ORDER_HEADERS = [
  'Order ID', 'Order reference', 'Order date (UTC)', 'Payment method', 'Order status', 'Delivery confirmed',
  'Customer name', 'Email', 'Phone', 'Items', 'Total', 'Currency',
  'Address line 1', 'Address line 2', 'City', 'Postal code', 'Country',
];
const HEADER_RANGE = `A1:${columnLetter(ORDER_HEADERS.length)}1`;
const ROW_RANGE_END = columnLetter(ORDER_HEADERS.length);
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.metadata.readonly'];
const ORDERS_BASE = `https://sheets.googleapis.com/v4/spreadsheets/${ORDERS_SHEET_ID}`;

const PAYMENT_METHOD_LABELS = {
  cod: 'Cash on delivery',
  bank_transfer: 'Bank transfer',
  youcanpay: 'Card',
  card: 'Card',
};
const STATUS_LABELS = {
  pending_payment: 'Awaiting payment',
  paid: 'Paid',
  payment_failed: 'Payment failed',
  partially_refunded: 'Partially refunded',
  refunded: 'Refunded',
};

function columnLetter(index) {
  // 26 → 'Z', 27 → 'AA'; the header list stays within one letter pair.
  let letter = '';
  let value = index;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    value = Math.floor((value - 1) / 26);
  }
  return letter;
}

/** The spreadsheet row for one order; every cell is a plain string like the customers sheet. */
export function orderSheetValues(order) {
  const shipping = order.shipping && order.shipping.line1 ? order.shipping : null;
  const items = Array.isArray(order.lines) ? order.lines : [];
  return [
    String(order.id || ''),
    String(order.reference || ''),
    order.createdAt instanceof Date ? order.createdAt.toISOString() : String(order.createdAt || ''),
    PAYMENT_METHOD_LABELS[order.paymentMethod] || String(order.paymentMethod || ''),
    STATUS_LABELS[order.status] || String(order.status || ''),
    shipping ? 'Yes' : 'No',
    String(order.name || ''),
    String(order.email || ''),
    String(order.phone || ''),
    items.map((line) => `${line.productName} (${line.option}) × ${line.quantity}`).join('; '),
    (Number(order.amountMinor) / 100).toFixed(2),
    String(order.currency || ''),
    shipping ? String(shipping.line1 || '') : '',
    shipping ? String(shipping.line2 || '') : '',
    shipping ? String(shipping.city || '') : '',
    shipping ? String(shipping.postalCode || '') : '',
    shipping ? String(shipping.country || '') : '',
  ];
}

export function createOrderSheetsService({ pool, credentialJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON } = {}) {
  let auth = null;
  let ready = false;
  try {
    const credentials = JSON.parse(credentialJson || '{}');
    if (credentials.type !== 'service_account' || !credentials.client_email || !credentials.private_key) throw new Error('INVALID_GOOGLE_KEY');
    auth = new JWT({ email: credentials.client_email, key: credentials.private_key, scopes: SCOPES });
  } catch {
    auth = null;
  }

  async function request(url, options = {}) {
    if (!auth) throw new Error('SHEETS_NOT_CONFIGURED');
    try {
      const result = await auth.request({ url, timeout: 12000, ...options });
      return result.data;
    } catch (error) {
      // Google errors may contain tokens/request metadata. Never forward or log them.
      const status = Number(error?.response?.status || error?.status || 0);
      throw new Error(status === 403 || status === 404 ? 'SHEETS_ACCESS_DENIED' : 'SHEETS_REQUEST_FAILED');
    }
  }

  async function checkPrivateSharing() {
    if (!auth) throw new Error('SHEETS_NOT_CONFIGURED');
    const permissions = [];
    let nextPageToken = '';
    do {
      const params = new URLSearchParams({ fields: 'nextPageToken,permissions(type,role)', pageSize: '100', includePermissionsForView: 'published', supportsAllDrives: 'true' });
      if (nextPageToken) params.set('pageToken', nextPageToken);
      const data = await request(`https://www.googleapis.com/drive/v3/files/${ORDERS_SHEET_ID}/permissions?${params}`);
      permissions.push(...(data.permissions || []));
      nextPageToken = data.nextPageToken || '';
    } while (nextPageToken);
    try { assertPrivatePermissions(permissions); }
    catch { throw new Error('ORDER_SHEET_NOT_PRIVATE'); }
  }

  async function inspect() {
    await checkPrivateSharing();
    let metadata = await request(`${ORDERS_BASE}?fields=sheets(properties(sheetId,title,gridProperties))`);
    let sheet = metadata.sheets?.find((item) => item.properties?.title === ORDER_TAB);
    if (!sheet) {
      // First run: create the Orders tab automatically, then the header row below.
      await request(`${ORDERS_BASE}:batchUpdate`, { method: 'POST', data: { requests: [{ addSheet: { properties: { title: ORDER_TAB } } }] } });
      metadata = await request(`${ORDERS_BASE}?fields=sheets(properties(sheetId,title,gridProperties))`);
      sheet = metadata.sheets?.find((item) => item.properties?.title === ORDER_TAB);
    }
    if (!sheet) throw new Error('ORDERS_TAB_MISSING');
    await request(`${ORDERS_BASE}/values/${encodeURIComponent(`${ORDER_TAB}!${HEADER_RANGE}`)}`, {
      method: 'PUT',
      data: { values: [ORDER_HEADERS] },
    });
    return sheet.properties;
  }

  async function verifyConnection() {
    ready = false;
    try {
      await inspect();
      ready = true;
      return { ok: true };
    } catch (error) {
      const allowedCodes = ['SHEETS_NOT_CONFIGURED', 'SHEETS_ACCESS_DENIED', 'SHEETS_REQUEST_FAILED', 'ORDER_SHEET_NOT_PRIVATE', 'ORDERS_TAB_MISSING', 'ORDERS_HEADERS_CHANGED'];
      return { ok: false, code: allowedCodes.includes(error.message) ? error.message : 'ORDER_SHEET_CONFIGURATION_INVALID' };
    }
  }

  async function syncOrder(order) {
    if (!ready || !pool) throw new Error('SHEETS_NOT_CONFIGURED');
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      // The same migration-record lock serializes spreadsheet writes across
      // instances and tabs; it contains no customer data.
      const [lock] = await connection.query('SELECT id FROM schema_migrations WHERE id = ? FOR UPDATE', ['001-accounts']);
      if (!lock.length) throw new Error('DATABASE_NOT_PREPARED');
      const sheet = await inspect();
      const idColumn = await request(`${ORDERS_BASE}/values/${encodeURIComponent(`${ORDER_TAB}!A2:A`)}`);
      const row = chooseCustomerRow(idColumn.values || [], order.id);
      if (row > sheet.gridProperties.rowCount) {
        await request(`${ORDERS_BASE}:batchUpdate`, { method: 'POST', data: { requests: [{ appendDimension: { sheetId: sheet.sheetId, dimension: 'ROWS', length: Math.max(1000, row - sheet.gridProperties.rowCount) } }] } });
      }
      // Re-identify the row by stable order ID on every retry, even after a
      // successful Google write followed by a lost network acknowledgement.
      await request(`${ORDERS_BASE}/values/${encodeURIComponent(`${ORDER_TAB}!A${row}:${ROW_RANGE_END}${row}`)}?valueInputOption=RAW`, {
        method: 'PUT',
        data: { values: [orderSheetValues(order)] },
      });
      await connection.commit();
    } catch (error) {
      try { await connection.rollback(); } catch { /* preserve safe error */ }
      if (error.message === 'ORDER_SHEET_NOT_PRIVATE') ready = false;
      throw new Error('ORDER_SYNC_FAILED');
    } finally {
      connection.release();
    }
  }

  return { get configured() { return ready; }, verifyConnection, syncOrder };
}
