/**
 * MariaDB profile store — the app's local-first database.
 *
 * Selected automatically when `MARIADB_DATABASE` + `MARIADB_USER` are set
 * (see `scripts/mariadb-init.sql` for the one-time database/user creation and
 * README → "Keeping the database on this PC" for the walkthrough).
 *
 * Design notes:
 *  - One small bounded pool. Writes are fire-and-forget exactly like the rest
 *    of the store: a slow or dead database must never block someone from
 *    joining the queue, so every write is caught and logged, never thrown.
 *  - The schema is created idempotently at startup — there is no migration
 *    step to forget when the app grows.
 *  - Rows untouched for 30 days are purged on a timer, mirroring the TTL index
 *    the MongoDB variant uses, so the table stays lean forever.
 */

const fs = require('fs');
const mysql = require('mysql2/promise');

const RETENTION_DAYS = 30;
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000; // every 5min — keeps hosted DBs awake
const CONNECT_TIMEOUT_MS = 4000;
/** Database names get interpolated into DDL — identifier-safe characters only. */
const SAFE_DB_NAME = /^[A-Za-z0-9_]+$/;

/** @type {import('mysql2/promise').Pool | null} */
let pool = null;
let purgeTimer = null;
let keepaliveTimer = null;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS profiles (
    session_id        VARCHAR(64)           NOT NULL,
    username          VARCHAR(64)           NOT NULL,
    age               TINYINT UNSIGNED      NOT NULL,
    gender            VARCHAR(16)           NOT NULL,
    country           VARCHAR(64)           NOT NULL,
    preferred_genders JSON                  NOT NULL,
    age_min           TINYINT UNSIGNED      NOT NULL DEFAULT 18,
    age_max           TINYINT UNSIGNED      NOT NULL DEFAULT 99,
    last_seen         TIMESTAMP             NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at        TIMESTAMP             NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id),
    KEY idx_username_country (username, country),
    KEY idx_last_seen (last_seen)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * Accounts + sessions — the persistence behind "create an account once, use it
 * anywhere, edit your preferences whenever you like".
 *
 * The password never lands in this table in the clear: `accounts.js` stores a
 * scrypt hash (salt:hex) in `password_hash`. Sessions are looked up by the
 * SHA-256 of the bearer token, so a leaked database row cannot be replayed as
 * a login either.
 */
const SCHEMA_ACCOUNTS = `
  CREATE TABLE IF NOT EXISTS accounts (
    id                INT UNSIGNED     NOT NULL AUTO_INCREMENT,
    username          VARCHAR(24)      NOT NULL,
    password_hash     VARCHAR(128)     NOT NULL,
    age               TINYINT UNSIGNED NOT NULL DEFAULT 25,
    gender            VARCHAR(16)      NOT NULL DEFAULT 'other',
    country           VARCHAR(64)      NOT NULL DEFAULT 'ZZ',
    preferred_genders JSON             NOT NULL,
    age_min           TINYINT UNSIGNED NOT NULL DEFAULT 18,
    age_max           TINYINT UNSIGNED NOT NULL DEFAULT 99,
    created_at        TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen         TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_accounts_username (username),
    KEY idx_accounts_last_seen (last_seen)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const SCHEMA_SESSIONS = `
  CREATE TABLE IF NOT EXISTS account_sessions (
    token_hash CHAR(64)    NOT NULL,
    account_id INT UNSIGNED NOT NULL,
    expires_at DATETIME    NOT NULL,
    created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (token_hash),
    KEY idx_sessions_expires (expires_at),
    CONSTRAINT fk_sessions_account FOREIGN KEY (account_id)
      REFERENCES accounts (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * The Passport — Matchup's country-collection layer ("collect the world, one
 * stranger at a time"). One row per stamped country plus one meta row per
 * account carrying the day-streak.
 *
 * Rows follow their account (`ON DELETE CASCADE`) and are never age-purged —
 * a collection that evaporates would destroy the very reason to come back.
 */
const SCHEMA_PASSPORT = `
  CREATE TABLE IF NOT EXISTS passport_stamps (
    account_id INT UNSIGNED NOT NULL,
    country    CHAR(2)      NOT NULL,
    count      INT UNSIGNED NOT NULL DEFAULT 1,
    last_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, country),
    CONSTRAINT fk_passport_stamps_account FOREIGN KEY (account_id)
      REFERENCES accounts (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const SCHEMA_PASSPORT_META = `
  CREATE TABLE IF NOT EXISTS passport_meta (
    account_id     INT UNSIGNED NOT NULL,
    streak         INT UNSIGNED NOT NULL DEFAULT 0,
    last_stamp_day DATE         DEFAULT NULL,
    updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                   ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id),
    CONSTRAINT fk_passport_meta_account FOREIGN KEY (account_id)
      REFERENCES accounts (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * Admins — the people who run the dashboard at `/admin`.
 *
 * Deliberately a SEPARATE table from `accounts`: an admin credential is a
 * different kind of secret, and a row in the user table must never be able to
 * grant dashboard access. Same scrypt hashing, same SHA-256 session tokens,
 * much shorter session lifetime (12h vs 30 days).
 */
const SCHEMA_ADMINS = `
  CREATE TABLE IF NOT EXISTS admins (
    id                INT UNSIGNED     NOT NULL AUTO_INCREMENT,
    username          VARCHAR(24)      NOT NULL,
    password_hash     VARCHAR(128)     NOT NULL,
    role              VARCHAR(16)      NOT NULL DEFAULT 'owner',
    created_at        TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen         TIMESTAMP        NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_admins_username (username)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const SCHEMA_ADMIN_SESSIONS = `
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash CHAR(64)    NOT NULL,
    admin_id   INT UNSIGNED NOT NULL,
    expires_at DATETIME    NOT NULL,
    created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (token_hash),
    KEY idx_admin_sessions_expires (expires_at),
    CONSTRAINT fk_admin_sessions_admin FOREIGN KEY (admin_id)
      REFERENCES admins (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * Payments — the paybill ledger.
 *
 * One row per "I have paid" intent. No account FK on purpose: deleting a user
 * must not delete the record of money that arrived on the bank statement.
 * `username` is a snapshot taken at intent time for the same reason.
 *
 * `status` walks pending → approved | rejected. Approving stamps
 * `premium_until` on the account (see `admin.js`).
 */
const SCHEMA_PAYMENTS = `
  CREATE TABLE IF NOT EXISTS payments (
    id            INT UNSIGNED     NOT NULL AUTO_INCREMENT,
    account_id    INT UNSIGNED     NOT NULL,
    username      VARCHAR(64)      NOT NULL,
    amount        DECIMAL(10,2)    NOT NULL DEFAULT 0,
    currency      CHAR(3)          NOT NULL DEFAULT 'KES',
    method        VARCHAR(16)      NOT NULL DEFAULT 'paybill',
    paybill       VARCHAR(24)      NOT NULL DEFAULT '',
    account_no    VARCHAR(64)      NOT NULL DEFAULT '',
    provider_ref  VARCHAR(64)      NULL DEFAULT NULL,
    status        VARCHAR(16)      NOT NULL DEFAULT 'pending',
    note          VARCHAR(255)     NULL DEFAULT NULL,
    premium_days  INT UNSIGNED     NULL DEFAULT NULL,
    reviewed_by   INT UNSIGNED     NULL DEFAULT NULL,
    reviewed_at   DATETIME         NULL DEFAULT NULL,
    created_at    TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_payments_status (status, created_at),
    KEY idx_payments_account (account_id, created_at),
    KEY idx_payments_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/** Key/value app settings (payment config, feature switches). Values are JSON. */
const SCHEMA_SETTINGS = `
  CREATE TABLE IF NOT EXISTS settings (
    \`key\`      VARCHAR(48)  NOT NULL,
    \`value\`    JSON         NOT NULL,
    updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                 ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`key\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/** Who did what in the dashboard — small, append-only, trimmed by age. */
const SCHEMA_AUDIT = `
  CREATE TABLE IF NOT EXISTS audit_log (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
    admin_id    INT UNSIGNED NULL DEFAULT NULL,
    admin_name  VARCHAR(24)  NOT NULL DEFAULT '',
    action      VARCHAR(48)  NOT NULL,
    target      VARCHAR(64)  NOT NULL DEFAULT '',
    detail      JSON         NULL DEFAULT NULL,
    created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_audit_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * The social platform: posts, the payment instrument behind every paid view,
 * the creator wallets and the group rooms.
 *
 * `charges` is deliberately the ONLY payment table for new money — a paid row
 * is both the receipt and the entitlement (purpose + ref_id points at the post
 * or the room it unlocked). Like `payments`, it carries no account FK: money
 * outlives users, and the username snapshots make that safe.
 *
 * `wallets.balance` is only ever moved with `UPDATE … SET balance = balance ± ?`
 * inside `socialStore`, so two simultaneous sales can never corrupt it.
 */
const SCHEMA_POSTS = `
  CREATE TABLE IF NOT EXISTS posts (
    id           INT UNSIGNED     NOT NULL AUTO_INCREMENT,
    account_id   INT UNSIGNED     NOT NULL,
    username     VARCHAR(24)      NOT NULL,
    type         VARCHAR(10)      NOT NULL DEFAULT 'text',
    caption      TEXT             NOT NULL,
    media_key    VARCHAR(80)      NULL DEFAULT NULL,
    link_url     VARCHAR(500)     NULL DEFAULT NULL,
    price        DECIMAL(10,2)    NOT NULL DEFAULT 0,
    currency     CHAR(3)          NOT NULL DEFAULT 'KES',
    is_adult     TINYINT(1)       NOT NULL DEFAULT 0,
    status       VARCHAR(12)      NOT NULL DEFAULT 'active',
    views        INT UNSIGNED     NOT NULL DEFAULT 0,
    likes_n      INT UNSIGNED     NOT NULL DEFAULT 0,
    comments_n   INT UNSIGNED     NOT NULL DEFAULT 0,
    purchases    INT UNSIGNED     NOT NULL DEFAULT 0,
    created_at   TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_posts_feed (status, created_at),
    KEY idx_posts_creator (account_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const SCHEMA_POST_LIKES = `
  CREATE TABLE IF NOT EXISTS post_likes (
    post_id     INT UNSIGNED NOT NULL,
    account_id  INT UNSIGNED NOT NULL,
    created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (post_id, account_id),
    KEY idx_post_likes_account (account_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const SCHEMA_POST_COMMENTS = `
  CREATE TABLE IF NOT EXISTS post_comments (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
    post_id     INT UNSIGNED NOT NULL,
    account_id  INT UNSIGNED NOT NULL,
    username    VARCHAR(24)  NOT NULL,
    body        VARCHAR(500) NOT NULL,
    status      VARCHAR(12)  NOT NULL DEFAULT 'active',
    created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_comments_post (post_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const SCHEMA_CHARGES = `
  CREATE TABLE IF NOT EXISTS charges (
    id                  INT UNSIGNED     NOT NULL AUTO_INCREMENT,
    purpose             VARCHAR(10)      NOT NULL,
    ref_id              INT UNSIGNED     NOT NULL,
    buyer_account_id    INT UNSIGNED     NOT NULL,
    buyer_username      VARCHAR(24)      NOT NULL,
    payee_account_id    INT UNSIGNED     NOT NULL,
    payee_username      VARCHAR(24)      NOT NULL,
    phone               VARCHAR(16)      NOT NULL DEFAULT '',
    amount              DECIMAL(10,2)    NOT NULL DEFAULT 0,
    currency            CHAR(3)          NOT NULL DEFAULT 'KES',
    commission          DECIMAL(10,2)    NOT NULL DEFAULT 0,
    net                 DECIMAL(10,2)    NOT NULL DEFAULT 0,
    status              VARCHAR(12)      NOT NULL DEFAULT 'pending',
    checkout_request_id VARCHAR(64)      NULL DEFAULT NULL,
    merchant_request_id VARCHAR(64)      NULL DEFAULT NULL,
    mpesa_receipt       VARCHAR(32)      NULL DEFAULT NULL,
    result_code         INT              NULL DEFAULT NULL,
    result_desc         VARCHAR(255)     NULL DEFAULT NULL,
    note                VARCHAR(255)     NULL DEFAULT NULL,
    created_at          TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    paid_at             DATETIME         NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_charges_checkout (checkout_request_id),
    KEY idx_charges_status (status, created_at),
    KEY idx_charges_ref (purpose, ref_id, status),
    KEY idx_charges_buyer (buyer_account_id, purpose, ref_id),
    KEY idx_charges_payee (payee_account_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const SCHEMA_WALLETS = `
  CREATE TABLE IF NOT EXISTS wallets (
    account_id    INT UNSIGNED   NOT NULL,
    balance       DECIMAL(12,2)  NOT NULL DEFAULT 0,
    lifetime_in   DECIMAL(12,2)  NOT NULL DEFAULT 0,
    lifetime_out  DECIMAL(12,2)  NOT NULL DEFAULT 0,
    updated_at    TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP
                    ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const SCHEMA_WALLET_ENTRIES = `
  CREATE TABLE IF NOT EXISTS wallet_entries (
    id          INT UNSIGNED     NOT NULL AUTO_INCREMENT,
    account_id  INT UNSIGNED     NOT NULL,
    amount      DECIMAL(12,2)    NOT NULL,
    kind        VARCHAR(16)      NOT NULL,
    status      VARCHAR(16)      NOT NULL DEFAULT 'posted',
    charge_id   INT UNSIGNED     NULL DEFAULT NULL,
    memo        VARCHAR(160)     NULL DEFAULT NULL,
    created_at  TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_wallet_entries_account (account_id, created_at),
    KEY idx_wallet_entries_status (status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const SCHEMA_ROOMS = `
  CREATE TABLE IF NOT EXISTS rooms (
    id              INT UNSIGNED     NOT NULL AUTO_INCREMENT,
    slug            VARCHAR(24)      NOT NULL,
    title           VARCHAR(80)      NOT NULL,
    kind            VARCHAR(12)      NOT NULL DEFAULT 'group',
    host_account_id INT UNSIGNED     NOT NULL,
    host_username   VARCHAR(24)      NOT NULL,
    price           DECIMAL(10,2)    NOT NULL DEFAULT 0,
    currency        CHAR(3)          NOT NULL DEFAULT 'KES',
    is_adult        TINYINT(1)       NOT NULL DEFAULT 0,
    max_participants TINYINT UNSIGNED NOT NULL DEFAULT 6,
    status          VARCHAR(12)      NOT NULL DEFAULT 'live',
    created_at      TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at        DATETIME         NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_rooms_slug (slug),
    KEY idx_rooms_status (status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * Columns added to the pre-existing `accounts` table.
 *
 * Written as information_schema checks instead of `ADD COLUMN IF NOT EXISTS`
 * because MariaDB supports that syntax and MySQL (Aiven, PlanetScale) does not.
 */
const ACCOUNT_COLUMNS = [
  ['banned_at', 'DATETIME NULL DEFAULT NULL'],
  ['premium_until', 'DATETIME NULL DEFAULT NULL'],
  ['last_ip', 'VARCHAR(45) NULL DEFAULT NULL'],
];

// `VALUES(col)` in the update clause is the MariaDB-compatible upsert form.
const UPSERT = `
  INSERT INTO profiles
    (session_id, username, age, gender, country, preferred_genders, age_min, age_max, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
  ON DUPLICATE KEY UPDATE
    username          = VALUES(username),
    age               = VALUES(age),
    gender            = VALUES(gender),
    country           = VALUES(country),
    preferred_genders = VALUES(preferred_genders),
    age_min           = VALUES(age_min),
    age_max           = VALUES(age_max),
    last_seen         = VALUES(last_seen)
`;

const STATS = `
  SELECT COUNT(DISTINCT username) AS users, COUNT(*) AS sessions FROM profiles
`;

const PURGE = `
  DELETE FROM profiles WHERE last_seen < NOW() - INTERVAL ${RETENTION_DAYS} DAY
`;

/** Expired sessions are dead weight — swept on the same timer as `PURGE`. */
const PURGE_SESSIONS = `
  DELETE FROM account_sessions WHERE expires_at < NOW()
`;

/** Audit rows older than 90 days are noise — swept on the same timer. */
const PURGE_AUDIT = `
  DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL 90 DAY
`;

/** True when MariaDB has been configured in the environment. */
function configured(env = process.env) {
  return Boolean(env.MARIADB_DATABASE && env.MARIADB_USER);
}

/**
 * TLS options for hosted databases (Aiven and friends require TLS and refuse
 * cleartext connections):
 *
 *   MARIADB_SSL=true            → TLS, don't verify the CA (quick start)
 *   MARIADB_SSL_CA=/path/ca.pem → TLS, verify against that CA (the right way)
 *   unset / anything else       → plain connection (local MariaDB default)
 */
function resolveSsl(env) {
  if (env.MARIADB_SSL_CA) {
    return { ca: fs.readFileSync(env.MARIADB_SSL_CA), rejectUnauthorized: true };
  }
  if (env.MARIADB_SSL === 'true' || env.MARIADB_SSL === '1') {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

/**
 * Open a pool. `database = null` connects without selecting a schema — used
 * once at boot to create the database itself on servers that ship empty
 * (hosted MySQL hands you a server with no databases of your own).
 */
function openPool(env, database) {
  const ssl = resolveSsl(env);
  const p = mysql.createPool({
    host: env.MARIADB_HOST || '127.0.0.1',
    port: Number(env.MARIADB_PORT) || 3306,
    user: env.MARIADB_USER,
    password: env.MARIADB_PASSWORD || '',
    ...(database ? { database } : {}),
    ...(ssl ? { ssl } : {}),
    connectionLimit: 5,
    connectTimeout: CONNECT_TIMEOUT_MS,
    enableKeepAlive: true,
    // Never let a single wedged query pin a connection forever.
    maxIdle: 10000,
    idleTimeout: 30000,
  });
  // The driver's default connection charset is a 3-byte UTF-8 variant; flag
  // emoji in usernames need 4 bytes. Force utf8mb4 on every pooled connection.
  // NB: the connection passed to this event is callback-style, NOT promise —
  // `conn.query(...).catch()` would throw here.
  p.on('connection', (conn) => {
    conn.query('SET NAMES utf8mb4', () => undefined);
  });
  return p;
}

/** Idempotent schema + one cleanup pass, against the current pool. */
async function applySchema() {
  await pool.query(SCHEMA);
  await pool.query(SCHEMA_ACCOUNTS);
  await pool.query(SCHEMA_SESSIONS);
  await pool.query(SCHEMA_PASSPORT); // FKs onto accounts — must come after it
  await pool.query(SCHEMA_PASSPORT_META);
  await pool.query(SCHEMA_ADMINS);
  await pool.query(SCHEMA_ADMIN_SESSIONS); // FKs onto admins
  await pool.query(SCHEMA_PAYMENTS); // deliberately no FK — money outlives users
  await pool.query(SCHEMA_SETTINGS);
  await pool.query(SCHEMA_AUDIT);
  // Social platform — after `accounts` (no FKs, but ordering keeps boot logs sane).
  await pool.query(SCHEMA_POSTS);
  await pool.query(SCHEMA_POST_LIKES);
  await pool.query(SCHEMA_POST_COMMENTS);
  await pool.query(SCHEMA_CHARGES);
  await pool.query(SCHEMA_WALLETS);
  await pool.query(SCHEMA_WALLET_ENTRIES);
  await pool.query(SCHEMA_ROOMS);
  await ensureAccountColumns();
  await pool.query(PURGE); // one cleanup per boot too
  await pool.query(PURGE_SESSIONS).catch(() => undefined);
  await pool.query(PURGE_AUDIT).catch(() => undefined);
}

/**
 * Add any missing `accounts` column (bans, premium, last IP) on a database
 * that predates them. Runs once at boot and is a no-op afterwards.
 */
async function ensureAccountColumns() {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accounts'`,
  );
  const have = new Set(rows.map((r) => String(r.name).toLowerCase()));
  for (const [column, definition] of ACCOUNT_COLUMNS) {
    if (have.has(column)) continue;
    console.warn(`[store] accounts.${column} missing — adding it`);
    await pool.query(`ALTER TABLE accounts ADD COLUMN \`${column}\` ${definition}`);
  }
}

/**
 * Connect, verify, create the schema and start the retention job.
 * Throws if the database is unreachable — the caller decides the fallback.
 */
async function init(env = process.env) {
  const host = env.MARIADB_HOST || '127.0.0.1';
  const port = Number(env.MARIADB_PORT) || 3306;
  const dbName = env.MARIADB_DATABASE;

  pool = openPool(env, dbName);

  let probe;
  try {
    [probe] = await pool.query('SELECT VERSION() AS version');
    await applySchema();
  } catch (err) {
    const missingDb =
      err && err.code === 'ER_BAD_DB_ERROR' && dbName && SAFE_DB_NAME.test(dbName);
    if (!missingDb) {
      await close().catch(() => undefined);
      throw err;
    }
    // Hosted MySQL (Aiven, …) ships without our database — create it here so
    // the app owns its schema end to end; no console clicking to forget.
    console.warn(`[store] database "${dbName}" does not exist — creating it`);
    try {
      await pool.end().catch(() => undefined);
      pool = openPool(env, null);
      await pool.query(
        `CREATE DATABASE IF NOT EXISTS \`${dbName}\`` +
          ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
      );
      await pool.end().catch(() => undefined);
      pool = openPool(env, dbName);
      [probe] = await pool.query('SELECT VERSION() AS version');
      await applySchema();
    } catch (err2) {
      await close().catch(() => undefined);
      throw err2;
    }
  }

  purgeTimer = setInterval(() => {
    pool?.query(PURGE).catch((err) => console.error('[store] purge failed:', err.message));
    pool
      ?.query(PURGE_SESSIONS)
      .catch((err) => console.error('[store] session purge failed:', err.message));
  }, PURGE_INTERVAL_MS);
  purgeTimer.unref?.();

  // A `SELECT 1` every 5 minutes: hosted free tiers power off databases that
  // see no traffic for hours, and this keeps both the pool and the instance
  // awake. It also warms connections, so the first visitor of the day isn't
  // the one paying the connect timeout.
  keepaliveTimer = setInterval(() => {
    pool?.query('SELECT 1').catch((err) => console.error('[store] keepalive failed:', err.message));
  }, KEEPALIVE_INTERVAL_MS);
  keepaliveTimer.unref?.();

  const [charset] = await pool.query(
    'SELECT @@character_set_client AS c, @@character_set_connection AS cc, @@character_set_results AS r',
  );
  console.info(
    `[store] connected to MariaDB ${probe[0].version} on ${host}:${port}` +
      ` (db=${dbName}, charset=${charset[0].c}/${charset[0].cc}/${charset[0].r})`,
  );
  return pool;
}

/**
 * Upsert one profile. Fire-and-forget: failures are logged, never rethrown.
 * @param {string} sessionId socket id → the row's primary key
 * @param {{username:string,age:number,gender:string,country:string,
 *          preferredGenders?:string[],ageMin?:number,ageMax?:number}} profile
 */
function save(sessionId, profile) {
  if (!pool) return;
  pool
    .query(UPSERT, [
      sessionId,
      profile.username,
      profile.age,
      profile.gender,
      profile.country,
      // mysql2 expands JS arrays into `(a,b)` lists — serialize explicitly.
      JSON.stringify(profile.preferredGenders ?? ['any']),
      profile.ageMin ?? 18,
      profile.ageMax ?? 99,
    ])
    .catch((err) => console.error('[store] save failed:', err.message));
}

/** Distinct users + total sessions, for `GET /api/stats`. */
async function stats() {
  if (!pool) return { users: 0, sessions: 0 };
  const [rows] = await pool.query(STATS);
  return { users: Number(rows[0].users) || 0, sessions: Number(rows[0].sessions) || 0 };
}

async function close() {
  if (purgeTimer) clearInterval(purgeTimer);
  purgeTimer = null;
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveTimer = null;
  if (pool) await pool.end();
  pool = null;
}

// ── Accounts ────────────────────────────────────────────────────────────────

/** Turn a raw `accounts` row (optionally joined with a session) into an object. */
function mapAccount(row) {
  if (!row) return null;
  let preferredGenders = ['any'];
  try {
    // mysql2 already decodes MariaDB `JSON` columns into arrays; older drivers
    // hand back the raw string. Accept both — `JSON.parse(array)` throws, which
    // used to silently reset everyone's preferences to "any" on every reload.
    const raw = row.preferred_genders;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed) && parsed.length > 0) preferredGenders = parsed;
  } catch {
    /* corrupted row — keep the permissive default rather than failing login */
  }
  return {
    id: Number(row.id),
    username: row.username,
    passwordHash: row.password_hash,
    // Suspension / entitlement / last seen address — set by the dashboard.
    banned: Boolean(row.banned_at),
    premiumUntil: row.premium_until ? new Date(row.premium_until) : null,
    lastIp: row.last_ip || null,
    profile: {
      username: row.username,
      age: Number(row.age),
      gender: row.gender,
      country: row.country,
      preferredGenders,
      ageMin: Number(row.age_min),
      ageMax: Number(row.age_max),
    },
    createdAt: row.created_at,
  };
}

/**
 * Insert a new account.
 * @throws `err.code === 'DUPLICATE'` when the username is already taken
 *         (the unique index is case-insensitive, so Alice/alice collide too).
 */
async function createAccount({ username, passwordHash, profile }) {
  if (!pool) {
    const err = new Error('database not ready');
    err.code = 'DB_UNAVAILABLE';
    throw err;
  }
  try {
    const [res] = await pool.query(
      `INSERT INTO accounts
         (username, password_hash, age, gender, country, preferred_genders, age_min, age_max)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        username,
        passwordHash,
        profile.age,
        profile.gender,
        profile.country,
        JSON.stringify(profile.preferredGenders ?? ['any']),
        profile.ageMin ?? 18,
        profile.ageMax ?? 99,
      ],
    );
    return { id: res.insertId, username, profile };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') err.code = 'DUPLICATE';
    throw err;
  }
}

/** @returns {object|null} account (with password hash) or null */
async function findAccount(username) {
  if (!pool) return null;
  const [rows] = await pool.query('SELECT * FROM accounts WHERE username = ? LIMIT 1', [username]);
  return mapAccount(rows[0]);
}

/**
 * Persist a user's freely-editable profile + preferences, then re-read it.
 * `username` is the *current* name (the WHERE key); `profile.username` is the
 * new one, so a rename happens in the same statement — the unique index is
 * what makes a rename collision fail instead of silently aliasing an account.
 */
async function updateAccountProfile(username, profile) {
  if (!pool) {
    const err = new Error('database not ready');
    err.code = 'DB_UNAVAILABLE';
    throw err;
  }
  try {
    await pool.query(
      `UPDATE accounts
          SET username = ?, age = ?, gender = ?, country = ?, preferred_genders = ?,
              age_min = ?, age_max = ?, last_seen = NOW()
        WHERE username = ?`,
      [
        profile.username,
        profile.age,
        profile.gender,
        profile.country,
        JSON.stringify(profile.preferredGenders ?? ['any']),
        profile.ageMin ?? 18,
        profile.ageMax ?? 99,
        username,
      ],
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') err.code = 'DUPLICATE';
    throw err;
  }
  return findAccount(profile.username);
}

/** Record a login so `last_seen` reflects real activity. */
async function touchAccount(id) {
  if (!pool) return;
  pool
    .query('UPDATE accounts SET last_seen = NOW() WHERE id = ?', [id])
    .catch((err) => console.error('[store] touch account failed:', err.message));
}

/**
 * Remember where an account last signed in from. The address is what a ban
 * falls back on when someone simply creates a new username — it is never
 * shown to anyone but an admin, and only ever written on an authenticated
 * action (register/login/passport sync), never on a public page view.
 */
function recordAccountIp(id, ip) {
  if (!pool || !id || !ip) return;
  const value = String(ip).slice(0, 45);
  pool
    .query('UPDATE accounts SET last_ip = ? WHERE id = ?', [value, Number(id)])
    .catch((err) => console.error('[store] record ip failed:', err.message));
}

/** Store a session keyed by the SHA-256 of the bearer token. */
async function createSession(tokenHash, accountId, ttlMs) {
  if (!pool) {
    const err = new Error('database not ready');
    err.code = 'DB_UNAVAILABLE';
    throw err;
  }
  await pool.query(
    'INSERT INTO account_sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)',
    [tokenHash, accountId, new Date(Date.now() + ttlMs)],
  );
}

/** Resolve a token hash to its account; expired sessions resolve to null. */
async function findSession(tokenHash) {
  if (!pool) return null;
  const [rows] = await pool.query(
    `SELECT a.*, s.expires_at AS expires_at
       FROM account_sessions s
       JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash = ? LIMIT 1`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return null;
  const expires = new Date(row.expires_at).getTime();
  if (!Number.isFinite(expires) || expires < Date.now()) {
    await deleteSession(tokenHash).catch(() => undefined);
    return null;
  }
  return mapAccount(row);
}

async function deleteSession(tokenHash) {
  if (!pool) return;
  await pool.query('DELETE FROM account_sessions WHERE token_hash = ?', [tokenHash]);
}

/** Revoke every live session of one account (used when a ban lands). */
async function deleteSessionsForAccount(accountId) {
  if (!pool) return 0;
  const [res] = await pool.query('DELETE FROM account_sessions WHERE account_id = ?', [
    Number(accountId),
  ]);
  return res.affectedRows ?? 0;
}

/**
 * Remove an account outright (sign-out everywhere, because of the FK cascade).
 * Used by the auth test to leave the database exactly as it found it.
 */
async function deleteAccount(username) {
  if (!pool) return 0;
  const [res] = await pool.query('DELETE FROM accounts WHERE username = ?', [username]);
  return res.affectedRows ?? 0;
}

/**
 * Load a user's passport: per-country counts + the streak meta row.
 * `DATE_FORMAT` forces a plain `YYYY-MM-DD` string so the day arithmetic in
 * `passport.js` never depends on the driver's DATE decoding.
 */
async function loadPassport(accountId) {
  if (!pool) return { stamps: {}, streak: 0, lastDay: null };
  const [stamps] = await pool.query(
    'SELECT country, count FROM passport_stamps WHERE account_id = ?',
    [accountId],
  );
  const [meta] = await pool.query(
    `SELECT streak, DATE_FORMAT(last_stamp_day, '%Y-%m-%d') AS last_day
       FROM passport_meta WHERE account_id = ?`,
    [accountId],
  );

  const map = {};
  for (const row of stamps) map[row.country] = Number(row.count) || 0;
  return {
    stamps: map,
    streak: meta[0] ? Number(meta[0].streak) || 0 : 0,
    lastDay: meta[0]?.last_day || null,
  };
}

/**
 * Persist the merged passport in two single statements: a multi-row upsert
 * that only ever raises a count (`GREATEST` keeps syncs idempotent), and the
 * meta row with the recomputed streak.
 */
async function savePassport(accountId, stamps, streak, lastDay) {
  if (!pool) return;
  const countries = Object.keys(stamps);
  if (countries.length > 0) {
    const values = countries.map(() => '(?, ?, ?)').join(', ');
    const params = countries.flatMap((cc) => [accountId, cc, stamps[cc]]);
    await pool.query(
      `INSERT INTO passport_stamps (account_id, country, count) VALUES ${values}
       ON DUPLICATE KEY UPDATE
         count  = GREATEST(count, VALUES(count)),
         last_at = CURRENT_TIMESTAMP`,
      params,
    );
  }
  await pool.query(
    `INSERT INTO passport_meta (account_id, streak, last_stamp_day)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       streak         = VALUES(streak),
       last_stamp_day = VALUES(last_stamp_day)`,
    [accountId, streak || 0, lastDay || null],
  );
}

// ── Admins ───────────────────────────────────────────────────────────────────

async function countAdmins() {
  if (!pool) return 0;
  const [rows] = await pool.query('SELECT COUNT(*) AS n FROM admins');
  return Number(rows[0].n) || 0;
}

async function createAdmin({ username, passwordHash, role = 'owner' }) {
  if (!pool) {
    const err = new Error('database not ready');
    err.code = 'DB_UNAVAILABLE';
    throw err;
  }
  try {
    const [res] = await pool.query(
      'INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)',
      [username, passwordHash, role],
    );
    return { id: res.insertId, username, role };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') err.code = 'DUPLICATE';
    throw err;
  }
}

async function findAdmin(username) {
  if (!pool) return null;
  const [rows] = await pool.query('SELECT * FROM admins WHERE username = ? LIMIT 1', [username]);
  const row = rows[0];
  return row
    ? { id: Number(row.id), username: row.username, passwordHash: row.password_hash, role: row.role }
    : null;
}

async function createAdminSession(tokenHash, adminId, ttlMs) {
  if (!pool) {
    const err = new Error('database not ready');
    err.code = 'DB_UNAVAILABLE';
    throw err;
  }
  await pool.query(
    'INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)',
    [tokenHash, adminId, new Date(Date.now() + ttlMs)],
  );
}

/** Resolve a token hash to its admin, or null when missing/expired. */
async function findAdminSession(tokenHash) {
  if (!pool) return null;
  const [rows] = await pool.query(
    `SELECT a.id, a.username, a.role, s.expires_at AS expires_at
       FROM admin_sessions s
       JOIN admins a ON a.id = s.admin_id
      WHERE s.token_hash = ? LIMIT 1`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return null;
  const expires = new Date(row.expires_at).getTime();
  if (!Number.isFinite(expires) || expires < Date.now()) {
    await deleteAdminSession(tokenHash).catch(() => undefined);
    return null;
  }
  return { id: Number(row.id), username: row.username, role: row.role };
}

async function deleteAdminSession(tokenHash) {
  if (!pool) return;
  await pool.query('DELETE FROM admin_sessions WHERE token_hash = ?', [tokenHash]);
}

async function touchAdmin(id) {
  if (!pool) return;
  pool.query('UPDATE admins SET last_seen = NOW() WHERE id = ?', [id]).catch(() => undefined);
}

// ── Users (dashboard) ────────────────────────────────────────────────────────

/** LIKE wildcards typed into the search box are literal characters. */
function likeEscape(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

const iso = (value) => (value ? new Date(value).toISOString() : null);

function mapUserRow(row) {
  return {
    id: Number(row.id),
    username: row.username,
    age: Number(row.age),
    gender: row.gender,
    country: row.country,
    createdAt: iso(row.created_at),
    lastSeen: iso(row.last_seen),
    lastIp: row.last_ip || null,
    banned: Boolean(row.banned_at),
    bannedAt: iso(row.banned_at),
    premiumUntil: iso(row.premium_until),
    countries: Number(row.countries) || 0,
    paymentsTotal: Number(row.payments_total) || 0,
    paymentsPending: Number(row.payments_pending) || 0,
  };
}

/**
 * Paged user list for the dashboard.
 * @param {{q?:string, filter?:'all'|'banned'|'premium', page?:number, size?:number}} opts
 */
async function listUsers({ q = '', filter = 'all', page = 1, size = 25 } = {}) {
  if (!pool) return { items: [], total: 0 };
  const where = [];
  const params = [];

  const needle = String(q || '').trim().slice(0, 40);
  if (needle) {
    where.push('a.username LIKE ?');
    params.push(`%${likeEscape(needle)}%`);
  }
  if (filter === 'banned') where.push('a.banned_at IS NOT NULL');
  if (filter === 'premium') where.push('a.premium_until IS NOT NULL AND a.premium_until > NOW()');

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const safeSize = Math.min(100, Math.max(1, Number(size) || 25));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safeSize;

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS n FROM accounts a ${clause}`,
    params,
  );
  const [rows] = await pool.query(
    `SELECT a.*,
            (SELECT COUNT(*) FROM passport_stamps p WHERE p.account_id = a.id) AS countries,
            (SELECT COALESCE(SUM(amount), 0) FROM payments pm
              WHERE pm.account_id = a.id AND pm.status = 'approved') AS payments_total,
            (SELECT COUNT(*) FROM payments pm
              WHERE pm.account_id = a.id AND pm.status = 'pending') AS payments_pending
       FROM accounts a
       ${clause}
      ORDER BY a.last_seen DESC, a.id DESC
      LIMIT ${safeSize} OFFSET ${offset}`,
    params,
  );

  return { items: rows.map(mapUserRow), total: Number(countRows[0].n) || 0 };
}

async function getUser(id) {
  if (!pool) return null;
  const [rows] = await pool.query('SELECT * FROM accounts WHERE id = ?', [Number(id)]);
  return rows[0] ? mapUserRow(rows[0]) : null;
}

/** Account ids/usernames currently banned — feeds the matchmaker's IP check. */
async function loadBannedIps() {
  if (!pool) return [];
  const [rows] = await pool.query(
    `SELECT id, username, last_ip FROM accounts
      WHERE banned_at IS NOT NULL AND last_ip IS NOT NULL AND last_ip <> ''`,
  );
  return rows.map((r) => ({ id: Number(r.id), username: r.username, ip: r.last_ip }));
}

/** Is this username (case-insensitive, like the unique index) suspended? */
async function findAccountByUsername(username) {
  if (!pool) return null;
  const [rows] = await pool.query(
    'SELECT id, username, banned_at, premium_until FROM accounts WHERE username = ? LIMIT 1',
    [String(username || '')],
  );
  const row = rows[0];
  return row
    ? {
        id: Number(row.id),
        username: row.username,
        banned: Boolean(row.banned_at),
        premiumUntil: iso(row.premium_until),
      }
    : null;
}

/**
 * Apply dashboard flags to one account.
 * @param {number} id
 * @param {{banned?: boolean, premiumDays?: number|null}} patch
 *   `premiumDays` adds that many days on top of whatever is left (never
 *   shortens an active subscription); `null` revokes premium outright.
 */
async function updateUserFlags(id, patch = {}) {
  if (!pool) {
    const err = new Error('database not ready');
    err.code = 'DB_UNAVAILABLE';
    throw err;
  }
  const sets = [];
  const params = [];

  if (typeof patch.banned === 'boolean') {
    sets.push(patch.banned ? 'banned_at = NOW()' : 'banned_at = NULL');
  }
  if (patch.premiumDays === null) {
    sets.push('premium_until = NULL');
  } else if (patch.premiumDays !== undefined) {
    const days = Math.min(3650, Math.max(0, Math.trunc(Number(patch.premiumDays))));
    if (!Number.isFinite(days)) throw Object.assign(new Error('bad premiumDays'), { code: 'BAD_INPUT' });
    sets.push('premium_until = DATE_ADD(GREATEST(COALESCE(premium_until, NOW()), NOW()), INTERVAL ? DAY)');
    params.push(days);
  }

  if (sets.length === 0) return getUser(id);
  params.push(Number(id));
  const [res] = await pool.query(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`, params);
  if (!res.affectedRows) return null;
  return getUser(id);
}

/** Delete an account outright (sessions/passport cascade). Payments survive. */
async function deleteUser(id) {
  if (!pool) return 0;
  const [res] = await pool.query('DELETE FROM accounts WHERE id = ?', [Number(id)]);
  return res.affectedRows ?? 0;
}

/** Headline numbers for the dashboard's top row. */
async function accountStats() {
  if (!pool) return { total: 0, new7d: 0, active7d: 0, banned: 0, premium: 0 };
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS total,
            SUM(created_at >= NOW() - INTERVAL 7 DAY) AS new7d,
            SUM(last_seen >= NOW() - INTERVAL 7 DAY) AS active7d,
            SUM(banned_at IS NOT NULL) AS banned,
            SUM(premium_until IS NOT NULL AND premium_until > NOW()) AS premium
       FROM accounts`,
  );
  const r = rows[0] || {};
  return {
    total: Number(r.total) || 0,
    new7d: Number(r.new7d) || 0,
    active7d: Number(r.active7d) || 0,
    banned: Number(r.banned) || 0,
    premium: Number(r.premium) || 0,
  };
}

// ── Payments ─────────────────────────────────────────────────────────────────

function mapPayment(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    accountId: Number(row.account_id),
    username: row.username,
    amount: Number(row.amount),
    currency: row.currency,
    method: row.method,
    paybill: row.paybill,
    accountNo: row.account_no,
    providerRef: row.provider_ref || null,
    status: row.status,
    note: row.note || null,
    premiumDays: row.premium_days == null ? null : Number(row.premium_days),
    reviewedBy: row.reviewed_by == null ? null : Number(row.reviewed_by),
    reviewedAt: iso(row.reviewed_at),
    createdAt: iso(row.created_at),
    /** Convenience for the UI: the payer is gone but the reference remains. */
    accountExists: Boolean(row.account_exists),
  };
}

/** Rewrite the account number on an open intent (settings/format changed). */
async function updatePaymentAccountNo(id, accountNo) {
  if (!pool) return null;
  await pool.query('UPDATE payments SET account_no = ? WHERE id = ? AND status = ?', [
    String(accountNo || '').slice(0, 64),
    Number(id),
    'pending',
  ]);
  return getPayment(id);
}

/** The open intent for an account — reused so retries get the same reference. */
async function findPendingPayment(accountId) {
  if (!pool) return null;
  const [rows] = await pool.query(
    `SELECT p.*, (a.id IS NOT NULL) AS account_exists
       FROM payments p LEFT JOIN accounts a ON a.id = p.account_id
      WHERE p.account_id = ? AND p.status = 'pending'
      ORDER BY p.id DESC LIMIT 1`,
    [Number(accountId)],
  );
  return mapPayment(rows[0]);
}

async function insertPayment({
  accountId,
  username,
  amount,
  currency,
  paybill,
  accountNo,
  providerRef = null,
  premiumDays = null,
}) {
  if (!pool) {
    const err = new Error('database not ready');
    err.code = 'DB_UNAVAILABLE';
    throw err;
  }
  const [res] = await pool.query(
    `INSERT INTO payments
       (account_id, username, amount, currency, method, paybill, account_no, provider_ref, premium_days)
     VALUES (?, ?, ?, ?, 'paybill', ?, ?, ?, ?)`,
    [
      Number(accountId),
      String(username).slice(0, 64),
      Number(amount) || 0,
      currency || 'KES',
      String(paybill || '').slice(0, 24),
      String(accountNo || '').slice(0, 64),
      providerRef ? String(providerRef).slice(0, 64) : null,
      premiumDays == null ? null : Number(premiumDays),
    ],
  );
  return getPayment(res.insertId);
}

async function getPayment(id) {
  if (!pool) return null;
  const [rows] = await pool.query(
    `SELECT p.*, (a.id IS NOT NULL) AS account_exists
       FROM payments p LEFT JOIN accounts a ON a.id = p.account_id
      WHERE p.id = ? LIMIT 1`,
    [Number(id)],
  );
  return mapPayment(rows[0]);
}

async function listPayments({ status = '', page = 1, size = 25 } = {}) {
  if (!pool) return { items: [], total: 0 };
  const where = [];
  const params = [];
  if (status) {
    where.push('p.status = ?');
    params.push(String(status));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const safeSize = Math.min(100, Math.max(1, Number(size) || 25));
  const safePage = Math.max(1, Number(page) || 1);

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS n FROM payments p ${clause}`,
    params,
  );
  const [rows] = await pool.query(
    `SELECT p.*, (a.id IS NOT NULL) AS account_exists
       FROM payments p LEFT JOIN accounts a ON a.id = p.account_id
       ${clause}
      ORDER BY p.id DESC
      LIMIT ${safeSize} OFFSET ${(safePage - 1) * safeSize}`,
    params,
  );
  return { items: rows.map(mapPayment), total: Number(countRows[0].n) || 0 };
}

/**
 * Move a payment to `approved` / `rejected` / back to `pending`.
 * Approval is where premium is granted — `premium_until` is bumped by the
 * payment's own recorded `premium_days`, so a later settings change can never
 * retroactively alter what someone paid for.
 */
async function reviewPayment(id, { status, note = null, adminId = null }) {
  if (!pool) return null;
  const allowed = new Set(['pending', 'approved', 'rejected']);
  if (!allowed.has(status)) {
    throw Object.assign(new Error('bad status'), { code: 'BAD_INPUT' });
  }

  const [rows] = await pool.query('SELECT * FROM payments WHERE id = ? LIMIT 1', [Number(id)]);
  const row = rows[0];
  if (!row) return null;

  // Only an approval that has not been applied yet grants premium — approving
  // twice (or re-opening a rejected row) must not extend anything twice.
  const granting = status === 'approved' && row.status !== 'approved';

  await pool.query(
    `UPDATE payments
        SET status = ?, note = ?, reviewed_by = ?, reviewed_at = NOW()
      WHERE id = ?`,
    [status, note ? String(note).slice(0, 255) : null, adminId, Number(id)],
  );

  if (granting) {
    const days = row.premium_days == null ? 0 : Number(row.premium_days);
    if (days > 0) {
      await pool.query(
        `UPDATE accounts
            SET premium_until = DATE_ADD(GREATEST(COALESCE(premium_until, NOW()), NOW()), INTERVAL ? DAY)
          WHERE id = ?`,
        [days, Number(row.account_id)],
      );
    }
  }

  return getPayment(id);
}

async function listPaymentsForAccount(accountId) {
  if (!pool) return [];
  const [rows] = await pool.query(
    `SELECT p.*, (a.id IS NOT NULL) AS account_exists
       FROM payments p LEFT JOIN accounts a ON a.id = p.account_id
      WHERE p.account_id = ? ORDER BY p.id DESC LIMIT 50`,
    [Number(accountId)],
  );
  return rows.map(mapPayment);
}

/** Ledger totals + a 14-day series for the dashboard's revenue chart. */
async function paymentSummary() {
  if (!pool) {
    return { pending: 0, approved: 0, approvedTotal: 0, rejected: 0, byDay: [] };
  }
  const [totals] = await pool.query(
    `SELECT
        SUM(status = 'pending') AS pending,
        SUM(status = 'approved') AS approved,
        SUM(status = 'rejected') AS rejected,
        COALESCE(SUM(CASE WHEN status = 'approved' THEN amount END), 0) AS approved_total
       FROM payments`,
  );
  const [days] = await pool.query(
    `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day,
            SUM(status = 'approved') AS count,
            COALESCE(SUM(CASE WHEN status = 'approved' THEN amount END), 0) AS total
       FROM payments
      WHERE created_at >= NOW() - INTERVAL 13 DAY
      GROUP BY day ORDER BY day`,
  );
  const t = totals[0] || {};
  const byDay = [];
  for (const row of days) {
    byDay.push({ day: row.day, count: Number(row.count) || 0, total: Number(row.total) || 0 });
  }
  return {
    pending: Number(t.pending) || 0,
    approved: Number(t.approved) || 0,
    rejected: Number(t.rejected) || 0,
    approvedTotal: Number(t.approved_total) || 0,
    byDay,
  };
}

// ── Settings ─────────────────────────────────────────────────────────────────

/** All settings rows as `{ key: parsedValue }`. Unavailable DB ⇒ `{}`. */
async function getSettings() {
  const out = {};
  if (!pool) return out;
  const [rows] = await pool.query('SELECT `key`, `value` FROM settings');
  for (const row of rows) {
    try {
      out[row.key] = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    } catch {
      /* corrupt row — the caller falls back to the default for that key */
    }
  }
  return out;
}

async function putSetting(key, value) {
  if (!pool) {
    const err = new Error('database not ready');
    err.code = 'DB_UNAVAILABLE';
    throw err;
  }
  await pool.query(
    'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
    [String(key).slice(0, 48), JSON.stringify(value ?? null)],
  );
}

// ── Audit log ────────────────────────────────────────────────────────────────

async function insertAudit({ adminId = null, adminName = '', action, target = '', detail = null }) {
  if (!pool) return;
  pool
    .query(
      'INSERT INTO audit_log (admin_id, admin_name, action, target, detail) VALUES (?, ?, ?, ?, ?)',
      [adminId, String(adminName).slice(0, 24), String(action).slice(0, 48), String(target).slice(0, 64), detail ? JSON.stringify(detail) : null],
    )
    .catch((err) => console.error('[audit] insert failed:', err.message));
}

async function listAudit(limit = 100) {
  if (!pool) return [];
  const safe = Math.min(500, Math.max(1, Number(limit) || 100));
  const [rows] = await pool.query(
    'SELECT * FROM audit_log ORDER BY id DESC LIMIT ?',
    [safe],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    adminId: row.admin_id == null ? null : Number(row.admin_id),
    adminName: row.admin_name,
    action: row.action,
    target: row.target,
    detail: typeof row.detail === 'string' ? safeParse(row.detail) : row.detail,
    createdAt: iso(row.created_at),
  }));
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Run one statement on the shared pool.
 *
 * The social layer (`socialStore.js`) owns its own tables but must reuse the
 * exact same connection pool — a second pool would double the connection count
 * on a `connectionLimit: 5` database for no benefit. Returns the raw result:
 * rows for SELECTs, the OkPacket (with `insertId` / `affectedRows`) otherwise.
 *
 * @throws `err.code === 'DB_UNAVAILABLE'` when no database is configured.
 */
async function query(sql, params = []) {
  if (!pool) {
    const err = new Error('database not ready');
    err.code = 'DB_UNAVAILABLE';
    throw err;
  }
  const [result] = await pool.query(sql, params);
  return result;
}

module.exports = {
  configured,
  init,
  save,
  stats,
  close,
  query,
  loadPassport,
  savePassport,
  createAccount,
  findAccount,
  updateAccountProfile,
  touchAccount,
  createSession,
  findSession,
  deleteSession,
  deleteSessionsForAccount,
  recordAccountIp,
  deleteAccount,
  // Admins
  countAdmins,
  createAdmin,
  findAdmin,
  createAdminSession,
  findAdminSession,
  deleteAdminSession,
  touchAdmin,
  // Dashboard users
  listUsers,
  getUser,
  loadBannedIps,
  findAccountByUsername,
  updateUserFlags,
  deleteUser,
  accountStats,
  // Payments
  findPendingPayment,
  updatePaymentAccountNo,
  insertPayment,
  getPayment,
  listPayments,
  reviewPayment,
  listPaymentsForAccount,
  paymentSummary,
  // Settings + audit
  getSettings,
  putSetting,
  insertAudit,
  listAudit,
};
