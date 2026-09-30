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
  await pool.query(PURGE); // one cleanup per boot too
  await pool.query(PURGE_SESSIONS).catch(() => undefined);
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

module.exports = {
  configured,
  init,
  save,
  stats,
  close,
  loadPassport,
  savePassport,
  createAccount,
  findAccount,
  updateAccountProfile,
  touchAccount,
  createSession,
  findSession,
  deleteSession,
  deleteAccount,
};
