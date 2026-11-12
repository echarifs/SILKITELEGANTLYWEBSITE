import mysql from 'mysql2/promise';

function sslOptionsFromDsn(url) {
  const inlineSsl = url.searchParams.get('ssl');
  if (inlineSsl) {
    try {
      const configured = JSON.parse(inlineSsl);
      if (configured === true) return { rejectUnauthorized: true };
      if (configured && typeof configured === 'object' && !Array.isArray(configured)) {
        return { ...configured, rejectUnauthorized: configured.rejectUnauthorized !== false };
      }
    } catch { throw new Error('Database TLS settings are invalid'); }
    throw new Error('Database TLS settings are invalid');
  }
  const mode = (url.searchParams.get('ssl-mode') || url.searchParams.get('ssl_mode') || '').toUpperCase();
  const sslCa = url.searchParams.get('ssl-ca');
  const sslCert = url.searchParams.get('ssl-cert');
  const sslKey = url.searchParams.get('ssl-key');
  if (!mode && !sslCa && !sslCert && !sslKey) return undefined;
  if (mode === 'DISABLED') return undefined;
  const ssl = {};
  if (sslCa) ssl.ca = sslCa;
  if (sslCert) ssl.cert = sslCert;
  if (sslKey) ssl.key = sslKey;
  // REQUIRED is the deliberate exception: encrypt without certificate verification.
  // All other explicit TLS configurations must verify the server certificate.
  ssl.rejectUnauthorized = mode !== 'REQUIRED';
  return ssl;
}

export function createPool({ databaseUrl = process.env.DATABASE_URL, ...overrides } = {}) {
  if (!databaseUrl || typeof databaseUrl !== 'string') throw new Error('DATABASE_URL is required');
  const url = new URL(databaseUrl);
  if (!/^mysql(?:\+mysql2)?:$/iu.test(url.protocol)) throw new Error('DATABASE_URL must use mysql://');
  const options = {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//u, '')),
    ssl: sslOptionsFromDsn(url),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 100,
    connectTimeout: 10_000,
    timezone: 'Z',
    charset: 'utf8mb4',
    ...overrides,
  };
  if (!options.ssl) delete options.ssl;
  return mysql.createPool(options);
}

const MIGRATION_ID = '001-accounts';

const statements = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    id VARCHAR(128) NOT NULL PRIMARY KEY,
    applied_at DATETIME(3) NOT NULL
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS customers (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    email VARCHAR(254) NOT NULL,
    name VARCHAR(128) NOT NULL,
    phone VARCHAR(40) NULL,
    address_line1 VARCHAR(200) NULL,
    address_line2 VARCHAR(200) NULL,
    city VARCHAR(120) NULL,
    postal_code VARCHAR(20) NULL,
    country CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NULL,
    password_hash TEXT NOT NULL,
    marketing_consent TINYINT(1) NOT NULL DEFAULT 0,
    verified_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL,
    sheet_row INT NULL,
    sheet_sync_status VARCHAR(16) NOT NULL DEFAULT 'pending',
    sheet_sync_error VARCHAR(64) NULL,
    sheet_sync_attempted_at DATETIME(3) NULL,
    UNIQUE KEY customers_email_unique (email)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS auth_sessions (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    token_hash BINARY(32) NOT NULL UNIQUE,
    csrf_token CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    created_at DATETIME(3) NOT NULL,
    last_seen_at DATETIME(3) NOT NULL,
    idle_expires_at DATETIME(3) NOT NULL,
    absolute_expires_at DATETIME(3) NOT NULL,
    revoked_at DATETIME(3) NULL,
    CONSTRAINT auth_sessions_user_fk FOREIGN KEY (user_id) REFERENCES customers(id) ON DELETE CASCADE,
    KEY auth_sessions_user_idx (user_id),
    KEY auth_sessions_expiry_idx (idle_expires_at, absolute_expires_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS auth_tokens (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    token_type VARCHAR(24) NOT NULL,
    token_hash BINARY(32) NOT NULL UNIQUE,
    expires_at DATETIME(3) NOT NULL,
    consumed_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL,
    CONSTRAINT auth_tokens_user_fk FOREIGN KEY (user_id) REFERENCES customers(id) ON DELETE CASCADE,
    KEY auth_tokens_lookup_idx (token_type, expires_at, consumed_at),
    KEY auth_tokens_user_idx (user_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS auth_rate_limits (
    bucket_key VARCHAR(320) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    window_started_at DATETIME(3) NOT NULL,
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    blocked_until DATETIME(3) NULL
  ) ENGINE=InnoDB`,
];

export async function migrate(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A MySQL pool is required');
  for (const statement of statements) await pool.query(statement);
  const [rows] = await pool.query('SELECT id FROM schema_migrations WHERE id = ? LIMIT 1', [MIGRATION_ID]);
  if (!rows.length) await pool.query('INSERT INTO schema_migrations (id, applied_at) VALUES (?, UTC_TIMESTAMP(3))', [MIGRATION_ID]);
  return MIGRATION_ID;
}

export { MIGRATION_ID };

// Address columns added after the initial rollout; existing databases receive
// them through guarded ALTERs below.
export const PROFILE_ADDRESS_MIGRATION_ID = '005-profile-address';

const ADDRESS_COLUMNS = [
  ['address_line1', 'VARCHAR(200) NULL'],
  ['address_line2', 'VARCHAR(200) NULL'],
  ['city', 'VARCHAR(120) NULL'],
  ['postal_code', 'VARCHAR(20) NULL'],
  ['country', 'CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NULL'],
];

export async function migrateProfileAddress(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A MySQL pool is required');
  const [applied] = await pool.query('SELECT id FROM schema_migrations WHERE id = ? LIMIT 1', [PROFILE_ADDRESS_MIGRATION_ID]);
  if (applied.length) return PROFILE_ADDRESS_MIGRATION_ID;
  for (const [column, definition] of ADDRESS_COLUMNS) {
    const [found] = await pool.query(
      'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
      ['customers', column],
    );
    // Table, column and definition values above are committed constants, not visitor input.
    if (!found.length) await pool.query(`ALTER TABLE customers ADD COLUMN ${column} ${definition}`);
  }
  await pool.query('INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES (?, UTC_TIMESTAMP(3))', [PROFILE_ADDRESS_MIGRATION_ID]);
  return PROFILE_ADDRESS_MIGRATION_ID;
}
