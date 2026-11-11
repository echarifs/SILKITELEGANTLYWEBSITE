import { JWT } from 'google-auth-library';

export const CUSTOMER_SHEET_ID = '16nJbuyTdPlDDSXnSRPGDFyyxjLS0Prif3FjupQfQQSc';
export const CUSTOMER_HEADERS = ['Customer ID', 'Name', 'Email', 'Phone', 'Marketing consent', 'Signup date (UTC)', 'Email verified', 'Verification date (UTC)'];
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.metadata.readonly'];
const SHEETS_BASE = `https://sheets.googleapis.com/v4/spreadsheets/${CUSTOMER_SHEET_ID}`;

export function customerSheetValues(user) {
  return [user.id, user.name, user.email, user.phone || '', Boolean(user.marketing_consent), new Date(user.created_at).toISOString(), Boolean(user.verified_at), user.verified_at ? new Date(user.verified_at).toISOString() : ''];
}

export function assertPrivatePermissions(permissions) {
  if (!Array.isArray(permissions) || !permissions.length || permissions.some(permission => ['anyone', 'domain'].includes(permission.type))) {
    throw new Error('CUSTOMER_SHEET_NOT_PRIVATE');
  }
}

export function chooseCustomerRow(values, customerId) {
  const ids = values.map(row => String(row?.[0] || ''));
  const matches = ids.map((id, index) => id === customerId ? index + 2 : null).filter(Boolean);
  if (matches.length > 1) throw new Error('DUPLICATE_CUSTOMER_ROWS');
  if (matches.length) return matches[0];
  const empty = ids.findIndex(id => !id.trim());
  return empty >= 0 ? empty + 2 : ids.length + 2;
}

export function createSheetsService({ pool, credentialJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON } = {}) {
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
    const permissions = [];
    let nextPageToken = '';
    do {
      const params = new URLSearchParams({ fields: 'nextPageToken,permissions(type,role)', pageSize: '100', includePermissionsForView: 'published', supportsAllDrives: 'true' });
      if (nextPageToken) params.set('pageToken', nextPageToken);
      const data = await request(`https://www.googleapis.com/drive/v3/files/${CUSTOMER_SHEET_ID}/permissions?${params}`);
      permissions.push(...(data.permissions || []));
      nextPageToken = data.nextPageToken || '';
    } while (nextPageToken);
    assertPrivatePermissions(permissions);
  }

  async function inspectDirectory() {
    await checkPrivateSharing();
    const metadata = await request(`${SHEETS_BASE}?fields=sheets(properties(sheetId,title,gridProperties))`);
    const sheet = metadata.sheets?.find(item => item.properties?.title === 'Customers');
    if (!sheet) throw new Error('CUSTOMERS_TAB_MISSING');
    const header = await request(`${SHEETS_BASE}/values/${encodeURIComponent('Customers!A1:H1')}`);
    if (CUSTOMER_HEADERS.some((value, index) => header.values?.[0]?.[index] !== value)) throw new Error('CUSTOMERS_HEADERS_CHANGED');
    return sheet.properties;
  }

  async function verifyConnection() {
    ready = false;
    try {
      await inspectDirectory();
      ready = true;
      return { ok: true };
    } catch (error) {
      const allowedCodes = ['SHEETS_NOT_CONFIGURED', 'SHEETS_ACCESS_DENIED', 'SHEETS_REQUEST_FAILED', 'CUSTOMER_SHEET_NOT_PRIVATE', 'CUSTOMERS_TAB_MISSING', 'CUSTOMERS_HEADERS_CHANGED'];
      return { ok: false, code: allowedCodes.includes(error.message) ? error.message : 'SHEETS_CONFIGURATION_INVALID' };
    }
  }

  async function syncCustomer(userId) {
    if (!ready || !pool) throw new Error('SHEETS_NOT_CONFIGURED');
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      // A single migration-record lock serializes spreadsheet writes across instances.
      // It contains no customer data and is not used by normal login/session requests.
      const [lock] = await connection.query('SELECT id FROM schema_migrations WHERE id = ? FOR UPDATE', ['001-accounts']);
      if (!lock.length) throw new Error('DATABASE_NOT_PREPARED');
      const [users] = await connection.query('SELECT * FROM customers WHERE id = ? FOR UPDATE', [userId]);
      const user = users[0];
      if (!user || !user.verified_at) throw new Error('UNVERIFIED_CUSTOMER');
      const sheet = await inspectDirectory();
      const idColumn = await request(`${SHEETS_BASE}/values/${encodeURIComponent('Customers!A2:A')}`);
      const row = chooseCustomerRow(idColumn.values || [], user.id);
      if (row > sheet.gridProperties.rowCount) {
        await request(`${SHEETS_BASE}:batchUpdate`, { method: 'POST', data: { requests: [{ appendDimension: { sheetId: sheet.sheetId, dimension: 'ROWS', length: Math.max(1000, row - sheet.gridProperties.rowCount) } }] } });
      }
      // Re-identify the row by stable customer ID on every retry, even after manual sorting
      // or a successful Google write followed by a lost database/network acknowledgement.
      await request(`${SHEETS_BASE}/values/${encodeURIComponent(`Customers!A${row}:H${row}`)}?valueInputOption=RAW`, { method: 'PUT', data: { values: [customerSheetValues(user)] } });
      await connection.query("UPDATE customers SET sheet_row = ?, sheet_sync_status = 'synced', sheet_sync_error = NULL, sheet_sync_attempted_at = UTC_TIMESTAMP(3) WHERE id = ?", [row, user.id]);
      await connection.commit();
    } catch (error) {
      try { await connection.rollback(); } catch { /* preserve safe error */ }
      if (error.message === 'CUSTOMER_SHEET_NOT_PRIVATE') ready = false;
      throw new Error('CUSTOMER_SYNC_FAILED');
    } finally {
      connection.release();
    }
  }

  return { get configured() { return ready; }, verifyConnection, syncCustomer };
}
