/**
 * Account API test — `npm run test:auth`
 *
 * Exercises the whole username/password lifecycle against the *running* server
 * (started with `scripts/local.sh start`, or spawned here if nothing listens):
 *
 *   register → duplicate rejected → wrong password rejected → login →
 *   silent re-login (`/me`) → profile saved (every field editable, rename too) →
 *   logout kills the session → weak input rejected.
 *
 * When MariaDB is configured (the normal deployment) the rows it creates are
 * deleted again at the end, so the database is left exactly as found. Any
 * `authtest_*` row left behind by a crashed run is swept too.
 *
 * Exit codes: 0 = all checks passed, 1 = failed.
 */
const path = require('path');
const { spawn } = require('child_process');

const URL_BASE = process.env.URL || 'http://localhost:4000';
const results = [];
const ok = (m) => {
  results.push('ok: ' + m);
  console.log('ok: ' + m);
};
const bad = (m) => {
  results.push('FAIL: ' + m);
  console.error('FAIL: ' + m);
};
const assert = (cond, m) => (cond ? ok(m) : bad(m));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROFILE = {
  age: 26,
  gender: 'female',
  country: 'KE',
  preferredGenders: ['male'],
  ageMin: 18,
  ageMax: 40,
};

/** Tiny fetch wrapper: returns {status, data} and never throws. */
async function api(pathname, { method = 'GET', body, token } = {}) {
  try {
    const res = await fetch(`${URL_BASE}${pathname}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    return { status: res.status, data };
  } catch (err) {
    return { status: 0, data: { error: { message: err.message } } };
  }
}

async function ping() {
  const res = await api('/health');
  return res.status === 200;
}

let spawnedServer = null;

async function ensureServer() {
  if (await ping()) return;
  spawnedServer = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..', 'server'),
    env: { ...process.env, PORT: '4000', CORS_ORIGIN: '*' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (await ping()) return;
  }
  spawnedServer.kill();
  throw new Error('server did not start on :4000');
}

/** Delete whatever this suite created (MariaDB only — memory mode needs no cleanup). */
async function cleanup(usernames, mode) {
  if (mode !== 'maria') return;
  let mysql;
  try {
    mysql = require(require.resolve('mysql2/promise', {
      paths: [path.join(__dirname, '..', 'server')],
    }));
  } catch {
    return;
  }

  const env = { ...process.env };
  // Read server/.env the same way the app does.
  const fs = require('fs');
  const file = path.join(__dirname, '..', 'server', '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (/^\s*(#|$)/.test(line)) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }

  const conn = await mysql
    .createConnection({
      host: env.MARIADB_HOST || '127.0.0.1',
      port: Number(env.MARIADB_PORT) || 3306,
      user: env.MARIADB_USER,
      password: env.MARIADB_PASSWORD || '',
      database: env.MARIADB_DATABASE,
      connectTimeout: 5000,
    })
    .catch(() => null);
  if (!conn) return;

  try {
    for (const name of usernames) {
      // Sessions cascade with the account row (FK ON DELETE CASCADE).
      const [res] = await conn.query('DELETE FROM accounts WHERE username = ?', [name]);
      if (res.affectedRows) console.log(`cleanup: removed test account "${name}"`);
    }
    // Sweep rows from earlier crashed runs (> 1h old, never a live test).
    // `e2e_*` accounts are created by `scripts/e2e.js` and are never cleaned
    // up there (no delete API by design), so they get swept here instead.
    const [stale] = await conn.query(
      `DELETE FROM accounts
        WHERE (username LIKE 'authtest_%' OR username LIKE 'e2e_%')
          AND created_at < NOW() - INTERVAL 1 HOUR`,
    );
    if (stale.affectedRows) console.log(`cleanup: swept ${stale.affectedRows} stale test account(s)`);
  } finally {
    await conn.end().catch(() => undefined);
  }
}

async function main() {
  await ensureServer();

  const health = await api('/health');
  assert(health.status === 200, 'GET /health answers');
  const mode = health.data?.accounts ?? 'memory';
  assert(Boolean(health.data), `health exposes the accounts backend (${mode})`);

  const suffix = Date.now().toString(36);
  const username = `authtest_${suffix}`;
  const password = 'correct-horse-battery';
  const created = [];

  try {
    // ── 1. Register ─────────────────────────────────────────────────────────
    const reg = await api('/api/auth/register', {
      method: 'POST',
      body: { username, password, profile: { ...PROFILE, username } },
    });
    assert(reg.status === 201, `register → 201 (${reg.status} ${JSON.stringify(reg.data?.error)})`);
    const token = reg.data?.token;
    const user = reg.data?.user;
    assert(Boolean(token), 'register returns a session token');
    assert(user?.username === username, `register returns the user (${user?.username})`);
    if (user?.username) created.push(user.username);

    // ── 2. Duplicate username is refused ────────────────────────────────────
    const dup = await api('/api/auth/register', {
      method: 'POST',
      body: { username: username.toUpperCase(), password, profile: { ...PROFILE, username } },
    });
    assert(dup.status === 409, `duplicate username → 409 (${dup.status})`);
    assert(
      /already taken/i.test(dup.data?.error?.message || ''),
      'duplicate error tells the user to sign in instead',
    );

    // ── 3. Wrong password refused, unknown user refused (same shape) ────────
    const wrong = await api('/api/auth/login', {
      method: 'POST',
      body: { username, password: 'not-the-password' },
    });
    assert(wrong.status === 401, `wrong password → 401 (${wrong.status})`);

    const ghost = await api('/api/auth/login', {
      method: 'POST',
      body: { username: `nobody_${suffix}`, password },
    });
    assert(ghost.status === 401, `unknown user → 401 (${ghost.status})`);
    assert(
      (ghost.data?.error?.message || '') === (wrong.data?.error?.message || ''),
      'unknown user and wrong password give the same message (no username oracle)',
    );

    // ── 4. Login works ──────────────────────────────────────────────────────
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: { username: username.toUpperCase(), password },
    });
    assert(login.status === 200, `login → 200 (${login.status})`);
    const token2 = login.data?.token;
    assert(Boolean(token2) && token2 !== token, 'login issues a fresh token');

    // ── 5. /me resolves both tokens ─────────────────────────────────────────
    const me = await api('/api/auth/me', { token });
    assert(me.status === 200 && me.data?.user?.username === username, 'GET /me resolves the token');
    const me2 = await api('/api/auth/me', { token: token2 });
    assert(me2.status === 200, 'GET /me resolves the second token');
    assert(
      me.data?.user?.profile?.age === PROFILE.age &&
        me.data?.user?.profile?.preferredGenders?.[0] === 'male',
      `GET /me returns the stored profile ${JSON.stringify(me.data?.user?.profile)}`,
    );

    const bogus = await api('/api/auth/me', { token: 'a'.repeat(43) });
    assert(bogus.status === 401, `garbage token → 401 (${bogus.status})`);
    const noToken = await api('/api/auth/me');
    assert(noToken.status === 401, `missing token → 401 (${noToken.status})`);

    // ── 6. Profile + preferences are freely editable ────────────────────────
    const renamed = `${username}_x`.slice(0, 24);
    const save = await api('/api/auth/profile', {
      method: 'PUT',
      token,
      body: {
        profile: {
          username: renamed,
          age: 33,
          gender: 'male',
          country: 'DE',
          preferredGenders: ['female', 'nonbinary'],
          ageMin: 21,
          ageMax: 55,
        },
      },
    });
    if (save.status === 200) created.push(renamed); // cleanup must use the new name
    assert(save.status === 200, `PUT /profile → 200 (${save.status} ${JSON.stringify(save.data?.error)})`);
    const saved = save.data?.user?.profile;
    assert(
      saved?.username === renamed &&
        saved?.age === 33 &&
        saved?.gender === 'male' &&
        saved?.country === 'DE' &&
        saved?.ageMin === 21 &&
        saved?.ageMax === 55,
      `every field persisted ${JSON.stringify(saved)}`,
    );
    assert(
      JSON.stringify(saved?.preferredGenders) === JSON.stringify(['female', 'nonbinary']),
      'preferences persisted verbatim',
    );

    // The renamed account still signs in under its new name…
    const relogin = await api('/api/auth/login', {
      method: 'POST',
      body: { username: renamed, password },
    });
    assert(relogin.status === 200, 'renamed account still signs in');

    // …and the old name is free again.
    const reuse = await api('/api/auth/register', {
      method: 'POST',
      body: { username, password, profile: { ...PROFILE, username } },
    });
    assert(reuse.status === 201, 'old username released after a rename');
    if (reuse.data?.user?.username) created.push(reuse.data.user.username);

    // ── 7. Validation ───────────────────────────────────────────────────────
    const weak = await api('/api/auth/register', {
      method: 'POST',
      body: { username: `authtest_weak_${suffix}`, password: 'short', profile: { ...PROFILE } },
    });
    assert(weak.status === 400, `weak password → 400 (${weak.status})`);

    // Country must be ISO-3166 alpha-2 — anything the validator cannot
    // sanitize is refused rather than guessed at.
    const badProfile = await api('/api/auth/register', {
      method: 'POST',
      body: {
        username: `authtest_bad_${suffix}`,
        password,
        profile: { ...PROFILE, username: 'bad', country: 'KENYA' },
      },
    });
    assert(badProfile.status === 400, `invalid country → 400 (${badProfile.status})`);

    // Ages outside 18-99 are clamped exactly the way `queue:join` clamps them,
    // so registration and matchmaking can never disagree about someone's age.
    const kidName = `authtest_kid_${suffix}`;
    const kid = await api('/api/auth/register', {
      method: 'POST',
      body: { username: kidName, password, profile: { ...PROFILE, username: 'kid', age: 12 } },
    });
    created.push(kidName); // absent rows delete as a no-op
    assert(
      kid.status === 201 && kid.data?.user?.profile?.age === 18,
      `age outside the band is clamped like the queue (${kid.status}, age ${kid.data?.user?.profile?.age})`,
    );

    // ── 8. Logout kills the session ─────────────────────────────────────────
    const out = await api('/api/auth/logout', { method: 'POST', token: token2 });
    assert(out.status === 204, `POST /logout → 204 (${out.status})`);
    const afterOut = await api('/api/auth/me', { token: token2 });
    assert(afterOut.status === 401, `token dead after logout (${afterOut.status})`);

    // The *other* token is a separate session and must survive the logout.
    const still = await api('/api/auth/me', { token });
    assert(still.status === 200, 'other session still valid after one logout');
  } finally {
    await cleanup(created, mode);
  }

  const failures = results.filter((r) => r.startsWith('FAIL'));
  console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
  if (spawnedServer) spawnedServer.kill();
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('CRASH: ' + err.message);
  if (spawnedServer) spawnedServer.kill();
  process.exit(1);
});
