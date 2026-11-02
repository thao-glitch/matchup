/**
 * Database linkage check — `npm run test:db`
 *
 * Answers "is the app really talking to the database on this PC, and can it
 * write to it?" — the four things that go wrong in practice:
 *
 *   1. configured?      MARIADB_* present in server/.env (or the environment)
 *   2. reachable?       the server answers on host:port
 *   3. correct schema?  the `profiles` table exists, utf8mb4 end to end
 *   4. writable?        an INSERT + read-back succeeds (rolled back, so the
 *                       database is left exactly as it was found)
 *
 * It reads `server/.env` exactly like the app does, so what it reports is what
 * the server will do at runtime.
 *
 * Exit codes: 0 = linked and writable, 1 = failed, 2 = not configured.
 */

const fs = require('fs');
const path = require('path');
const mysql = require(require.resolve('mysql2/promise', {
  paths: [path.join(__dirname, '..', 'server')],
}));

const log = (...a) => console.log(...a);

/** Minimal .env reader — keeps this script dependency-free. */
function readServerEnv() {
  const file = path.join(__dirname, '..', 'server', '.env');
  const fromFile = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (/^\s*(#|$)/.test(line)) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) fromFile[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return { file, fromFile };
}

function fail(message, code = 1) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function main() {
  const { file, fromFile } = readServerEnv();
  // The real environment wins over the file — same rule the server follows.
  const env = { ...fromFile, ...process.env };
  const usingFile = fs.existsSync(file) ? path.relative(process.cwd(), file) : '(no file)';
  log(`config: ${usingFile}`);

  if (!env.MARIADB_DATABASE || !env.MARIADB_USER) {
    throw fail(
      'MariaDB is not configured.\n' +
        '         Set MARIADB_USER / MARIADB_PASSWORD / MARIADB_DATABASE in server/.env\n' +
        '         (README → "Keeping the database on this PC"), or run the app with MONGODB_URI instead.',
      2,
    );
  }

  const host = env.MARIADB_HOST || '127.0.0.1';
  const port = Number(env.MARIADB_PORT) || 3306;
  const db = env.MARIADB_DATABASE;
  log(`target: ${env.MARIADB_USER}@${host}:${port}/${db}`);

  let conn;
  try {
    conn = await mysql.createConnection({
      host,
      port,
      user: env.MARIADB_USER,
      password: env.MARIADB_PASSWORD || '',
      database: db,
      connectTimeout: 5000,
      multipleStatements: false,
    });
  } catch (err) {
    throw fail(
      `cannot connect: ${err.message}\n` +
        '         Is the service running?  sudo systemctl start mariadb',
    );
  }

  try {
    // 2. Server identity
    const [[ver]] = await conn.query('SELECT VERSION() AS v');
    log(`ok: connected — MariaDB ${ver.v}`);

    // 3. We are inside the right database
    const [[cur]] = await conn.query(
      'SELECT DATABASE() AS db, @@character_set_client AS c, @@character_set_connection AS cc, @@character_set_results AS r',
    );
    if (cur.db !== db) throw fail(`connected to database "${cur.db}", expected "${db}"`);
    log(`ok: database "${cur.db}" selected`);

    // 4. utf8mb4 end to end — flag emoji in usernames need 4 bytes
    const charsets = [cur.c, cur.cc, cur.r];
    if (charsets.some((c) => !/^utf8mb4/i.test(String(c)))) {
      throw fail(`connection charset is ${charsets.join('/')} — expected utf8mb4 everywhere`);
    }
    log(`ok: charset utf8mb4 (${charsets.join('/')})`);

    // 5. Schema created by the app on startup
    const [tables] = await conn.query('SHOW TABLES LIKE ?', ['profiles']);
    if (tables.length !== 1) {
      throw fail('table "profiles" is missing — start the server once, it creates the schema');
    }
    log('ok: schema present (profiles)');

    // 6. Write round-trip with an emoji, rolled back so nothing is left behind
    const probe = {
      session_id: '__db_check__',
      username: 'probe-🇰🇪',
      age: 30,
      gender: 'other',
      country: 'ZZ',
      preferred_genders: JSON.stringify(['any']),
      age_min: 18,
      age_max: 99,
    };
    await conn.beginTransaction();
    try {
      await conn.query(
        'INSERT INTO profiles (session_id, username, age, gender, country, preferred_genders, age_min, age_max, last_seen) VALUES (?,?,?,?,?,?,?,?,NOW())',
        [
          probe.session_id,
          probe.username,
          probe.age,
          probe.gender,
          probe.country,
          probe.preferred_genders,
          probe.age_min,
          probe.age_max,
        ],
      );
      const [[row]] = await conn.query('SELECT username FROM profiles WHERE session_id = ?', [
        probe.session_id,
      ]);
      if (!row || row.username !== probe.username) {
        throw fail(`read-back mismatch: wrote ${probe.username}, got ${row && row.username}`);
      }
      log(`ok: write + read-back round-trip ("${row.username}")`);
    } finally {
      await conn.rollback();
    }

    // 7. How much has the app stored so far?
    const [[counts]] = await conn.query(
      'SELECT COUNT(*) AS sessions, COUNT(DISTINCT username) AS users, MIN(created_at) AS since FROM profiles',
    );
    log(
      `ok: ${counts.sessions} profile row(s) across ${counts.users} distinct user(s)` +
        (counts.sessions > 0 ? ` (first written ${new Date(counts.since).toISOString()})` : ''),
    );

    log('\nDatabase linked: the app will persist profiles on this machine.');
    return 0;
  } finally {
    await conn.end().catch(() => undefined);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\nFAIL: ${err.message}`);
    process.exit(typeof err.code === 'number' ? err.code : 1);
  });
