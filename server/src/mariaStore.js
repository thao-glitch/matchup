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
const path = require('path');
const mysql = require('mysql2/promise');

const RETENTION_DAYS = 30;
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000; // every 5min — keeps hosted DBs awake
// A remote TLS handshake (hosted MySQL) needs more than a LAN connect: free
// tiers can take a moment to answer a cold connection. 15s fails over to the
// in-memory store slowly enough to never trigger on a healthy database.
const CONNECT_TIMEOUT_MS = Number(process.env.MARIADB_CONNECT_TIMEOUT_MS) || 15000;

/** Read an integer env var and clamp it to a safe range. */
function envInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// A serverless instance can create many short-lived connections. Keep the
// per-instance pool small by default: 5 × 15 warm instances ≈ 75 connections,
// which is the production database's current `max_connections`. Raise this
// only after raising the database limit or adding a proxy (PgBouncer-style).
const POOL_SIZE = envInt(process.env.MARIADB_POOL_SIZE, 5, 1, 50);
const READ_POOL_SIZE = envInt(process.env.MARIADB_READ_POOL_SIZE, 5, 1, 50);
const QUEUE_LIMIT = envInt(process.env.MARIADB_QUEUE_LIMIT, 0, 0, 10000);
const IDLE_TIMEOUT_MS = envInt(process.env.MARIADB_IDLE_TIMEOUT_MS, 30000, 1000, 600000);
const MAX_IDLE = envInt(process.env.MARIADB_MAX_IDLE, 10000, 0, 600000);

// Hosted free MySQL/MariaDB tiers commonly cap the primary at 1 GB. The admin
// dashboard reports usage against this budget. Raise the value when the plan
// grows; it is display-only and never limits writes.
const STORAGE_LIMIT_MB = envInt(process.env.MARIADB_STORAGE_LIMIT_MB, 1024, 64, 1048576);

/** Database names get interpolated into DDL — identifier-safe characters only. */
const SAFE_DB_NAME = /^[A-Za-z0-9_]+$/;

/** @type {import('mysql2/promise').Pool | null} */
let pool = null;
/** Optional read replica. Null means every read stays on the primary. */
let readPool = null;
let readHost = '';
let readError = null;
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
 * Payments — the LEGACY paybill ledger.
 *
 * This table is no longer written to: every payment (premium included) now
 * goes through `charges` as an STK push, which settles itself from the Daraja
 * callback the moment the buyer enters their PIN. The table is kept because
 * rows already on it are the record of money that arrived on the bank
 * statement, and the dashboard still summarises them — but nothing creates or
 * reviews a row here any more.
 *
 * No account FK on purpose: deleting a user must not delete the record of
 * money that arrived. `username` is a snapshot taken at intent time for the
 * same reason.
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
 * `charges` is the ONLY payment table for money — a paid row is both the
 * receipt and the entitlement (`purpose` + `ref_id` points at the post, the
 * room, or the premium subscription it bought). Like `payments`, it carries no
 * account FK: money outlives users, and the username snapshots make that safe.
 *
 * `premium_days` is set only on `purpose = 'premium'` rows and is stamped at
 * creation time, so a later edit to the Settings price/period can never change
 * what an already-prompted buyer was promised (see `commerce.resolveTarget`).
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
    KEY idx_posts_creator (account_id, created_at),
    KEY idx_posts_media (media_key)
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
    premium_days        SMALLINT UNSIGNED NULL DEFAULT NULL,
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

/**
 * Follows and creator subscriptions.
 *
 * `follows` is the free relationship (a creator's audience). `creator_subs`
 * is the creator's own offer — enabled or not, and at what price/period.
 * `subscriptions` is one row per subscriber/creator pair; renewals extend
 * `expires_at` in place, so there is never a second live row to reconcile.
 *
 * A subscription is paid through the same `charges` ledger as posts and rooms
 * (`purpose = 'sub'`, `ref_id = creator account id`), which is what makes the
 * M-PESA callback, the status poll and the dashboard reconcile identically.
 */
const SCHEMA_FOLLOWS = `
  CREATE TABLE IF NOT EXISTS follows (
    follower_id INT UNSIGNED NOT NULL,
    creator_id  INT UNSIGNED NOT NULL,
    created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (follower_id, creator_id),
    KEY idx_follows_creator (creator_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const SCHEMA_CREATOR_SUBS = `
  CREATE TABLE IF NOT EXISTS creator_subs (
    account_id  INT UNSIGNED     NOT NULL,
    enabled     TINYINT(1)       NOT NULL DEFAULT 0,
    price       DECIMAL(10,2)    NOT NULL DEFAULT 0,
    currency    CHAR(3)          NOT NULL DEFAULT 'KES',
    period_days SMALLINT UNSIGNED NOT NULL DEFAULT 30,
    perk        VARCHAR(160)     NOT NULL DEFAULT '',
    updated_at  TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP
                  ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const SCHEMA_SUBSCRIPTIONS = `
  CREATE TABLE IF NOT EXISTS subscriptions (
    id            INT UNSIGNED     NOT NULL AUTO_INCREMENT,
    subscriber_id INT UNSIGNED     NOT NULL,
    creator_id    INT UNSIGNED     NOT NULL,
    status        VARCHAR(12)      NOT NULL DEFAULT 'active',
    price         DECIMAL(10,2)    NOT NULL DEFAULT 0,
    currency      CHAR(3)          NOT NULL DEFAULT 'KES',
    period_days   SMALLINT UNSIGNED NOT NULL DEFAULT 30,
    charge_id     INT UNSIGNED     NULL DEFAULT NULL,
    started_at    TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at    DATETIME         NULL DEFAULT NULL,
    canceled_at   DATETIME         NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_subscriber_creator (subscriber_id, creator_id),
    KEY idx_sub_creator (creator_id, status, expires_at),
    KEY idx_sub_expires (expires_at)
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

/**
 * Columns added to the pre-existing `charges` table — `premium_days` when the
 * subscription moved onto the STK flow.
 */
const CHARGE_COLUMNS = [
  ['premium_days', 'SMALLINT UNSIGNED NULL DEFAULT NULL'],
  // The period a creator subscription was quoted at, stamped on the charge so
  // a later price/period edit cannot change what an open prompt buys.
  ['period_days', 'SMALLINT UNSIGNED NULL DEFAULT NULL'],
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

/** Admin sessions expire after 12h; expired rows are dead weight. */
const PURGE_ADMIN_SESSIONS = `
  DELETE FROM admin_sessions WHERE expires_at < NOW()
`;

/** Old call history is only useful for a short rejoin window. */
const PAIRLOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PURGE_PAIRLOG = `
  DELETE FROM rt_pairlog WHERE ended_at < ?
`;

/** Expired subscriptions stop granting access; the row stays as history. */
const PURGE_SUBS = `
  UPDATE subscriptions SET status = 'expired'
   WHERE status IN ('active', 'canceled') AND expires_at IS NOT NULL AND expires_at <= NOW()
`;

/** True when MariaDB has been configured in the environment. */
function configured(env = process.env) {
  return Boolean(env.MARIADB_DATABASE && env.MARIADB_USER);
}

/**
 * TLS options for hosted databases (Aiven and friends require TLS and refuse
 * cleartext connections):
 *
 *   MARIADB_SSL=true            → TLS, verify against the CA store
 *                                 (Aiven, PlanetScale, RDS… — the default and
 *                                 the only mode used in production). If the
 *                                 runtime's CA store does not know the
 *                                 provider's chain — hosted CAs rotate — the
 *                                 connection is retried encrypted-but-unverified
 *                                 rather than refusing to boot; see `init`.
 *   MARIADB_SSL_CA=/path/ca.pem → TLS, verify against that CA file
 *   MARIADB_SSL=insecure        → TLS without verification (self-signed dev)
 *   unset / anything else       → plain connection (local MariaDB default)
 */
function resolveSsl(env) {
  if (env.MARIADB_SSL_CA) {
    return { ca: fs.readFileSync(env.MARIADB_SSL_CA), rejectUnauthorized: !sslRelaxed };
  }
  if (env.MARIADB_SSL === 'insecure' || (sslRelaxed && env.MARIADB_SSL)) {
    return { rejectUnauthorized: false };
  }
  if (env.MARIADB_SSL === 'true' || env.MARIADB_SSL === '1') {
    return { rejectUnauthorized: true };
  }
  return undefined;
}

/** Set when a verified TLS handshake failed on trust — retry unverified. */
let sslRelaxed = false;

const TLS_TRUST_ERROR =
  /self-signed|unable to verify|self signed|certificate (is not|has expired)|unable to get local issuer/i;

/**
 * Open a pool. `database = null` connects without selecting a schema — used
 * once at boot to create the database itself on servers that ship empty
 * (hosted MySQL hands you a server with no databases of your own).
 */
function openPool(env, database, { read = false } = {}) {
  const host = read ? env.MARIADB_READ_HOST : env.MARIADB_HOST;
  const port = read ? env.MARIADB_READ_PORT : env.MARIADB_PORT;
  const user = read ? env.MARIADB_READ_USER || env.MARIADB_USER : env.MARIADB_USER;
  const password = read
    ? env.MARIADB_READ_PASSWORD || env.MARIADB_PASSWORD || ''
    : env.MARIADB_PASSWORD || '';
  // A replica may use its own TLS settings (for example, a cross-region
  // replica with a different CA). Fall back to the primary's settings.
  const sslEnv = read
    ? {
        ...env,
        MARIADB_SSL: env.MARIADB_READ_SSL ?? env.MARIADB_SSL,
        MARIADB_SSL_CA: env.MARIADB_READ_SSL_CA ?? env.MARIADB_SSL_CA,
      }
    : env;
  const ssl = resolveSsl(sslEnv);
  const p = mysql.createPool({
    host: host || '127.0.0.1',
    port: Number(port) || 3306,
    user,
    password,
    ...(database ? { database } : {}),
    ...(ssl ? { ssl } : {}),
    connectionLimit: read ? READ_POOL_SIZE : POOL_SIZE,
    waitForConnections: true,
    queueLimit: QUEUE_LIMIT,
    connectTimeout: CONNECT_TIMEOUT_MS,
    enableKeepAlive: true,
    // Never let a single wedged query pin a connection forever.
    maxIdle: MAX_IDLE,
    idleTimeout: IDLE_TIMEOUT_MS,
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

/**
 * Realtime over HTTP (the platform this runs on has no long-lived sockets):
 * the1v1 queue, active pairs, the per-session inbox every event is written to
 * and read from by long-poll, and the live room roster. All rows are small and
 * pruned lazily — nothing here is a source of truth beyond a couple of minutes.
 */
const SCHEMA_RT = [
  `CREATE TABLE IF NOT EXISTS rt_sessions (
    sid      VARCHAR(64)  NOT NULL PRIMARY KEY,
    profile  MEDIUMTEXT   NULL,
    country  VARCHAR(8)   NULL,
    at       BIGINT       NOT NULL DEFAULT 0,
    INDEX rt_sessions_at (at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS rt_queue (
    sid       VARCHAR(64) NOT NULL PRIMARY KEY,
    profile   MEDIUMTEXT  NOT NULL,
    joined_at BIGINT      NOT NULL DEFAULT 0,
    INDEX rt_queue_join (joined_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS rt_pairs (
    call_id   VARCHAR(40) NOT NULL PRIMARY KEY,
    room_id   VARCHAR(40) NOT NULL,
    a_sid     VARCHAR(64) NOT NULL,
    b_sid     VARCHAR(64) NOT NULL,
    created_at BIGINT     NOT NULL DEFAULT 0,
    INDEX rt_pairs_a (a_sid),
    INDEX rt_pairs_b (b_sid)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS rt_pairlog (
    room_id  VARCHAR(40) NOT NULL,
    sid      VARCHAR(64) NOT NULL,
    ended_at BIGINT      NOT NULL DEFAULT 0,
    PRIMARY KEY (sid, ended_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS rt_inbox (
    id         BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    to_sid     VARCHAR(64)  NOT NULL,
    event      VARCHAR(24)  NOT NULL,
    payload    MEDIUMTEXT   NULL,
    created_at BIGINT       NOT NULL DEFAULT 0,
    INDEX rt_inbox_poll (to_sid, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS rt_roomlive (
    slug       VARCHAR(80) NOT NULL,
    sid        VARCHAR(64) NOT NULL,
    account_id INT         NOT NULL,
    username   VARCHAR(64) NOT NULL,
    country    VARCHAR(8)  NOT NULL DEFAULT '',
    at         BIGINT      NOT NULL DEFAULT 0,
    PRIMARY KEY (slug, sid),
    INDEX rt_roomlive_at (at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

/** Paid media lives in the database, not on disk — the host has no writable
 *  volume and the same bytes must survive a redeploy. LONGBLOB: a short clip
 *  tops out well under the 4 GB ceiling (uploads are capped at 32 MB anyway). */
const SCHEMA_MEDIA_BLOBS = `
  CREATE TABLE IF NOT EXISTS media_blobs (
    \`key\`    VARCHAR(80) NOT NULL PRIMARY KEY,
    mime       VARCHAR(48) NOT NULL,
    data       LONGBLOB    NOT NULL,
    created_at BIGINT      NOT NULL DEFAULT 0,
    KEY idx_media_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

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
  await pool.query(SCHEMA_FOLLOWS);
  await pool.query(SCHEMA_CREATOR_SUBS);
  await pool.query(SCHEMA_SUBSCRIPTIONS);
  for (const stmt of SCHEMA_RT) await pool.query(stmt);
  await pool.query(SCHEMA_MEDIA_BLOBS);
  await ensureAccountColumns();
  await ensureChargeColumns();
  // Existing databases predate these cleanup indexes.
  await ensureIndex('posts', 'idx_posts_media', 'media_key');
  await ensureIndex('media_blobs', 'idx_media_created', 'created_at');
  await pool.query(PURGE); // one cleanup per boot too
  await pool.query(PURGE_SESSIONS).catch(() => undefined);
  await pool.query(PURGE_AUDIT).catch(() => undefined);
  await pool.query(PURGE_SUBS).catch(() => undefined);
  await pool.query(PURGE_ADMIN_SESSIONS).catch(() => undefined);
  await pool
    .query(PURGE_PAIRLOG, [Date.now() - PAIRLOG_RETENTION_MS])
    .catch(() => undefined);
}

/**
 * Add any missing column on a table that predates it. Runs once at boot and
 * is a no-op afterwards.
 */
async function ensureColumns(table, columns) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table],
  );
  const have = new Set(rows.map((r) => String(r.name).toLowerCase()));
  for (const [column, definition] of columns) {
    if (have.has(column)) continue;
    console.warn(`[store] ${table}.${column} missing — adding it`);
    await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
}

const ensureAccountColumns = () => ensureColumns('accounts', ACCOUNT_COLUMNS);
const ensureChargeColumns = () => ensureColumns('charges', CHARGE_COLUMNS);

/** Add a missing index once; `CREATE INDEX IF NOT EXISTS` is not portable. */
async function ensureIndex(table, name, columns) {
  const [rows] = await pool.query(
    `SELECT INDEX_NAME AS name FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
      LIMIT 1`,
    [table, name],
  );
  if (rows.length) return;
  console.warn(`[store] ${table}.${name} missing — adding it`);
  await pool.query(`ALTER TABLE \`${table}\` ADD INDEX \`${name}\` (${columns})`);
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

  // Verified TLS first. Hosted providers rotate their CA chains, and a runtime
  // whose bundle predates the new root cannot verify — the connection then
  // fails outright. Retry encrypted-but-unverified instead: an unverifiable
  // database is still encrypted, and the alternative is losing every feature.
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    if (
      !sslRelaxed &&
      resolveSsl(env)?.rejectUnauthorized &&
      TLS_TRUST_ERROR.test(String(err.message || ''))
    ) {
      console.warn('[store] TLS verification failed — reconnecting encrypted but without CA verification');
      sslRelaxed = true;
      await close().catch(() => undefined);
      pool = openPool(env, dbName);
      await pool.query('SELECT 1').catch(() => undefined); // real errors surface below
    }
  }

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

  // Optional read replica. A missing/unhealthy replica must never stop the
  // app: reads fall back to the primary, and the dashboard reports it.
  if (env.MARIADB_READ_HOST) {
    readHost = String(env.MARIADB_READ_HOST).trim();
    try {
      readPool = openPool(env, dbName, { read: true });
      await readPool.query('SELECT 1');
      readError = null;
      console.info(`[store] read replica connected: ${readHost}`);
    } catch (err) {
      readError = err.message;
      console.warn('[store] read replica unavailable — reads stay on primary:', err.message);
      await readPool?.end().catch(() => undefined);
      readPool = null;
    }
  }

  // Disk → database: media must live in rows on a read-only filesystem host.
  await migrateUploadsToDb().catch((err) =>
    console.warn('[store] upload migration failed:', err.message),
  );

  purgeTimer = setInterval(() => {
    pool?.query(PURGE).catch((err) => console.error('[store] purge failed:', err.message));
    pool
      ?.query(PURGE_SESSIONS)
      .catch((err) => console.error('[store] session purge failed:', err.message));
    pool
      ?.query(PURGE_AUDIT)
      .catch((err) => console.error('[store] audit purge failed:', err.message));
    pool
      ?.query(PURGE_SUBS)
      .catch((err) => console.error('[store] subscription purge failed:', err.message));
    pool
      ?.query(PURGE_ADMIN_SESSIONS)
      .catch((err) => console.error('[store] admin session purge failed:', err.message));
    pool
      ?.query(PURGE_PAIRLOG, [Date.now() - PAIRLOG_RETENTION_MS])
      .catch((err) => console.error('[store] pairlog purge failed:', err.message));
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
  if (readPool) await readPool.end().catch(() => undefined);
  readPool = null;
  readHost = '';
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
  const accountId = Number(id);
  // Social relationships have no FK on purpose (they mirror the posts tables),
  // so remove both directions before the account row disappears.
  await pool
    .query('DELETE FROM follows WHERE follower_id = ? OR creator_id = ?', [accountId, accountId])
    .catch(() => undefined);
  await pool
    .query('DELETE FROM subscriptions WHERE subscriber_id = ? OR creator_id = ?', [accountId, accountId])
    .catch(() => undefined);
  await pool.query('DELETE FROM creator_subs WHERE account_id = ?', [accountId]).catch(() => undefined);
  const [res] = await pool.query('DELETE FROM accounts WHERE id = ?', [accountId]);
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

/** One pool's local connection counters — no DB round-trip. */
function poolSnapshot(p) {
  const core = p?.pool;
  const count = (value) => {
    if (!value) return 0;
    // mysql2 uses a RingQueue for these pools; a plain array is tolerated too.
    if (Array.isArray(value._list)) return value._list.filter(Boolean).length;
    if (Array.isArray(value)) return value.length;
    if (typeof value.size === 'number') return value.size;
    return Number(value) || 0;
  };
  return {
    limit: Number(core?.config?.connectionLimit) || 0,
    total: count(core?._allConnections),
    free: count(core?._freeConnections),
    queued: count(core?._connectionQueue),
  };
}

/** Replica state for the dashboard; never includes credentials. */
function readReplicaStatus() {
  return {
    configured: Boolean(readHost),
    healthy: Boolean(readPool),
    host: readHost,
    error: readError,
    pool: poolSnapshot(readPool),
  };
}

/**
 * Live database footprint for the admin dashboard.
 *
 * `table_rows` is InnoDB's estimate, not a `COUNT(*)` — exact counts on a
 * billion-row table would be a full scan on every dashboard refresh. Sizes are
 * exact enough for capacity planning (`data_length + index_length`).
 */
async function dbStats() {
  if (!pool) return null;
  const [[versionRow]] = await pool.query('SELECT VERSION() AS version, DATABASE() AS db');
  const [tables] = await pool.query(
    `SELECT table_name AS name,
            table_rows AS rows_est,
            data_length AS data_bytes,
            index_length AS index_bytes
       FROM information_schema.tables
      WHERE table_schema = DATABASE()
      ORDER BY (data_length + index_length) DESC`,
  );
  // Some managed MariaDB users cannot read global status/variables. The
  // footprint is still useful without them, so degrade to zero rather than
  // failing the whole admin card.
  let statusRows = [];
  try {
    [statusRows] = await pool.query('SHOW GLOBAL STATUS');
  } catch {
    statusRows = [];
  }
  const status = new Map(statusRows.map((row) => [row.Variable_name, row.Value]));
  let varRows = [];
  try {
    [varRows] = await pool.query('SHOW VARIABLES');
  } catch {
    varRows = [];
  }
  const vars = new Map(varRows.map((row) => [row.Variable_name, row.Value]));

  const mapped = tables.map((row) => {
    const dataBytes = Number(row.data_bytes) || 0;
    const indexBytes = Number(row.index_bytes) || 0;
    return {
      name: row.name,
      rows: Number(row.rows_est) || 0,
      dataBytes,
      indexBytes,
      totalBytes: dataBytes + indexBytes,
    };
  });

  const totalBytes = mapped.reduce((sum, row) => sum + row.totalBytes, 0);
  const dataBytes = mapped.reduce((sum, row) => sum + row.dataBytes, 0);
  const indexBytes = mapped.reduce((sum, row) => sum + row.indexBytes, 0);
  const capacityBytes = STORAGE_LIMIT_MB * 1024 * 1024;
  const usedPct = capacityBytes > 0 ? (totalBytes / capacityBytes) * 100 : 0;

  return {
    version: versionRow?.version || '',
    database: versionRow?.db || '',
    totalBytes,
    dataBytes,
    indexBytes,
    capacityBytes,
    capacityLimitMb: STORAGE_LIMIT_MB,
    usedPct: Number(usedPct.toFixed(2)),
    headroomBytes: Math.max(0, capacityBytes - totalBytes),
    tables: mapped,
    connections: {
      current: Number(status.get('Threads_connected')) || 0,
      running: Number(status.get('Threads_running')) || 0,
      max: Number(vars.get('max_connections')) || 0,
    },
    pool: poolSnapshot(pool),
    replica: readReplicaStatus(),
    maxAllowedPacket: Number(vars.get('max_allowed_packet')) || 0,
    innodbPageSize: Number(vars.get('innodb_page_size')) || 0,
    uptimeSec: Number(status.get('Uptime')) || 0,
  };
}

// ── Legacy paybill ledger ────────────────────────────────────────────────────

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
 * Paid-media blobs: the bytes behind `posts.media_key`. Stored in the
 * database because the runtime filesystem is read-only in production.
 */
async function saveMediaBlob(key, mime, buffer) {
  await query(
    `INSERT INTO media_blobs (\`key\`, mime, data, created_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE mime = VALUES(mime), data = VALUES(data)`,
    [key, mime, buffer, Date.now()],
  );
  return key;
}

async function getMediaBlob(key) {
  const rows = await query('SELECT mime, data FROM media_blobs WHERE `key` = ?', [key]);
  return rows[0] || null;
}

async function deleteMediaBlob(key) {
  await query('DELETE FROM media_blobs WHERE `key` = ?', [key]);
}

/**
 * Every media key the database still references. Used by the object-storage
 * lifecycle job as a keep-set before it deletes orphaned Blob objects.
 */
async function listMediaKeys() {
  const rows = await query(
    `SELECT media_key AS k FROM posts WHERE media_key IS NOT NULL AND media_key <> ''`,
  );
  return rows.map((row) => String(row.k)).filter(Boolean);
}

/**
 * Delete historical database media that no post references and that is older
 * than the retention cutoff. New uploads live in Vercel Blob, so this only
 * touches the legacy `media_blobs` table.
 *
 * @returns {Promise<number>} rows deleted (or that would be deleted in dry-run)
 */
async function purgeMediaBlobs(cutoffMs, { dryRun = false } = {}) {
  const cutoff = Number(cutoffMs) || 0;
  if (dryRun) {
    const rows = await query(
      `SELECT COUNT(*) AS n
         FROM media_blobs mb
         LEFT JOIN posts p ON p.media_key = mb.key
        WHERE p.id IS NULL AND mb.created_at < ?`,
      [cutoff],
    );
    return Number(rows[0]?.n) || 0;
  }
  const result = await query(
    `DELETE mb FROM media_blobs mb
      LEFT JOIN posts p ON p.media_key = mb.key
      WHERE p.id IS NULL AND mb.created_at < ?`,
    [cutoff],
  );
  return Number(result.affectedRows) || 0;
}

/**
 * One-time backfill: move files left over from the disk era into the database
 * so a host with a read-only filesystem serves every historical post. Runs on
 * each boot; after the first pass the directory is empty and it no-ops.
 */
async function migrateUploadsToDb() {
  const dir = path.join(__dirname, '..', 'uploads');
  let files = [];
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    return; // no legacy uploads directory at all
  }
  let moved = 0;
  for (const key of files) {
    if (!/^[A-Za-z0-9._-]{4,80}$/.test(key)) continue;
    try {
      const data = await fs.promises.readFile(path.join(dir, key));
      const mime =
        { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm' }[
          path.extname(key).toLowerCase()
        ] || 'application/octet-stream';
      await saveMediaBlob(key, mime, data);
      await fs.promises.unlink(path.join(dir, key));
      moved += 1;
    } catch (err) {
      console.warn(`[store] upload migration skipped ${key}: ${err.message}`);
    }
  }
  if (moved > 0) console.info(`[store] migrated ${moved} upload(s) into the database`);
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

/**
 * Read-only query. Uses the optional replica when configured, and falls back
 * to the primary if the replica is down or its schema is still catching up.
 *
 * Only callers that explicitly tolerate replication lag should use this:
 * public feeds, creator cards and comment lists. Auth, money, entitlements,
 * moderation and anything the caller just wrote must use `query()`.
 */
async function queryRead(sql, params = []) {
  if (readPool) {
    try {
      const [result] = await readPool.query(sql, params);
      readError = null;
      return result;
    } catch (err) {
      readError = err.message;
      console.warn('[store] read replica query failed — using primary:', err.message);
    }
  }
  return query(sql, params);
}

module.exports = {
  configured,
  init,
  save,
  stats,
  close,
  query,
  queryRead,
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
  dbStats,
  // Legacy paybill ledger (read-only — see the table's note in SCHEMA_PAYMENTS)
  paymentSummary,
  // Settings + audit
  getSettings,
  putSetting,
  insertAudit,
  listAudit,
  // Paid-media blobs (database-backed uploads)
  saveMediaBlob,
  getMediaBlob,
  deleteMediaBlob,
  listMediaKeys,
  purgeMediaBlobs,
};
