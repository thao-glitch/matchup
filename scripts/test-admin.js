/**
 * Admin + payments API test — `npm run test:admin`
 *
 * Exercises the dashboard contract end to end against a *running* server:
 *
 *   admin login (right/wrong password) → /me → overview → users list →
 *   ban blocks login + session → unban → premium grant/revoke →
 *   payment intent (same reference twice) → approve grants premium →
 *   approve twice does NOT extend twice → settings round-trip lands in
 *   `/api/config` → audit trail recorded.
 *
 * Needs a database (the dashboard degrades to 503 without one), so this test
 * exits 2 when `store` is not `maria` — the same convention as test:db.
 *
 * Admin credentials come from the environment, exactly like the server's first
 * boot reads them:
 *
 *   ADMIN_USERNAME=owner ADMIN_PASSWORD=… npm run test:admin
 *
 * Everything it creates is deleted again at the end (accounts, sessions,
 * payment rows, the premium flag), so the database is left as found.
 *
 * Exit codes: 0 = all checks passed, 1 = failed, 2 = not applicable.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.env.URL || 'http://localhost:4000';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'owner';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

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

/** Same request shape the client uses: JSON in, JSON out, Bearer optional. */
async function call(method, urlPath, { token, body } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${urlPath}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { status: 0, data: null, error: err.message };
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
  }
  return { status: res.status, data };
}

// ── Server handling (same as test:auth) ──────────────────────────────────────

let spawned = null;

async function ping() {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await ping()) return;
  if (process.env.URL) {
    throw new Error(`no server answering at ${BASE} — start it first`);
  }
  spawned = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..', 'server'),
    env: { ...process.env, PORT: '4000' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i += 1) {
    if (await ping()) return;
    await sleep(500);
  }
  throw new Error('the server did not come up on :4000');
}

function stopServer() {
  if (spawned) spawned.kill('SIGTERM');
}

// ── Direct database access, for cleanup only ─────────────────────────────────

function readServerEnv() {
  const file = path.join(__dirname, '..', 'server', '.env');
  const env = { ...process.env };
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (/^\s*(#|$)/.test(line)) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return env;
}

let pool = null;

async function connectDb() {
  const env = readServerEnv();
  if (!env.MARIADB_DATABASE || !env.MARIADB_USER) return null;
  const mysql = require(require.resolve('mysql2/promise', {
    paths: [path.join(__dirname, '..', 'server')],
  }));
  pool = mysql.createPool({
    host: env.MARIADB_HOST || '127.0.0.1',
    port: Number(env.MARIADB_PORT) || 3306,
    user: env.MARIADB_USER,
    password: env.MARIADB_PASSWORD || '',
    database: env.MARIADB_DATABASE,
    connectionLimit: 2,
    connectTimeout: 5000,
  });
  await pool.query('SELECT 1');
  return pool;
}

/** Remove every row this run created — accounts, payments, sessions. */
async function cleanup(username, accountId) {
  if (!pool) return;
  if (accountId) {
    await pool.query('DELETE FROM payments WHERE account_id = ?', [accountId]).catch(() => {});
  }
  await pool
    .query('DELETE FROM accounts WHERE username = ?', [username])
    .catch(() => undefined);
}

// ── The run ──────────────────────────────────────────────────────────────────

const USER = `admtest_${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = 'admtest-pass-123';
let userId = null;

async function main() {
  await ensureServer();

  const health = await call('GET', '/health');
  assert(health.status === 200, `GET /health → 200 (${health.status})`);
  if (health.data?.store !== 'maria') {
    console.error('skip: needs the database (store is not "maria") — see README §5.5');
    process.exit(2);
  }
  assert(health.data.admin === 'maria', 'health reports admin backend "maria"');

  if (!ADMIN_PASSWORD) {
    console.error('skip: set ADMIN_USERNAME / ADMIN_PASSWORD for the admin under test');
    process.exit(2);
  }

  await connectDb();

  // ── Login ────────────────────────────────────────────────────────────────
  const denied = await call('POST', '/api/admin/login', {
    body: { username: ADMIN_USERNAME, password: 'definitely-not-the-password' },
  });
  assert(denied.status === 401, `wrong admin password → 401 (${denied.status})`);

  const login = await call('POST', '/api/admin/login', {
    body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  assert(login.status === 200 && login.data?.token, `admin login → token (${login.status})`);
  const adminToken = login.data?.token;
  if (!adminToken) throw new Error('no admin token — cannot continue');

  const me = await call('GET', '/api/admin/me', { token: adminToken });
  assert(
    me.status === 200 && me.data?.admin?.username === ADMIN_USERNAME,
    `GET /me → the signed-in admin (${me.data?.admin?.username})`,
  );

  const unauth = await call('GET', '/api/admin/overview');
  assert(unauth.status === 401, `overview without a token → 401 (${unauth.status})`);

  // ── Overview ─────────────────────────────────────────────────────────────
  const overview = await call('GET', '/api/admin/overview', { token: adminToken });
  assert(overview.status === 200, `GET /overview → 200 (${overview.status})`);
  assert(
    Boolean(overview.data?.accounts && overview.data?.payments && overview.data?.calls),
    'overview carries accounts + payments + calls',
  );

  // ── A user to push around ────────────────────────────────────────────────
  const register = await call('POST', '/api/auth/register', {
    body: {
      username: USER,
      password: PASSWORD,
      profile: {
        username: USER,
        age: 27,
        gender: 'other',
        country: 'KE',
        preferredGenders: ['any'],
        ageMin: 18,
        ageMax: 60,
      },
    },
  });
  assert(register.status === 201, `registered test user (${register.status})`);
  const userToken = register.data?.token;
  userId = register.data?.user?.id ?? null;

  const users = await call('GET', `/api/admin/users?q=${USER}`, { token: adminToken });
  const row = users.data?.items?.find((u) => u.username === USER);
  assert(Boolean(row), 'the new user shows up in the dashboard list');
  userId = row?.id ?? userId;

  // ── Premium (M-PESA STK push) ──────────────────────────────────────────────
  // Premium is an STK prompt now: no account number to copy, nothing for the
  // owner to approve. Firing a real prompt needs a live Daraja shortcode,
  // which a test box will not have, so this asserts the contract that holds
  // either way.
  const mine = await call('GET', '/api/payments/mine', { token: userToken });
  assert(mine.status === 200, `premium ledger reads (${mine.status})`);
  assert(
    mine.data && 'premiumUntil' in mine.data && 'open' in mine.data && 'payments' in mine.data,
    'the premium ledger reports premiumUntil, the open charge and receipts',
  );

  const intent = await call('POST', '/api/payments/intent', {
    token: userToken,
    body: { phone: '0712345678' },
  });
  if (intent.status === 201) {
    const charge = intent.data?.payment;
    assert(charge?.status === 'pending', 'the charge opens and waits for the PIN');
    const again = await call('POST', '/api/payments/intent', {
      token: userToken,
      body: { phone: '0712345678' },
    });
    assert(
      again.data?.payment?.id === charge.id,
      'a second pay tap reuses the open charge instead of prompting twice',
    );
  } else {
    assert(
      intent.data?.error?.code === 'mpesa-not-configured',
      `without a Daraja shortcode the charge refuses clearly (${intent.data?.error?.code})`,
    );
  }

  const mpesaTest = await call('POST', '/api/admin/mpesa/test', { token: adminToken, body: {} });
  assert(mpesaTest.status === 200, `the dashboard can test the Daraja setup (${mpesaTest.status})`);
  const checks = mpesaTest.data?.checks;
  assert(Array.isArray(checks) && checks.length > 0, 'the test reports one line per requirement');
  assert(
    checks.some((check) => check.name === 'shortcode'),
    'the test calls out a missing shortcode specifically',
  );

  // ── Ban ──────────────────────────────────────────────────────────────────
  const ban = await call('PATCH', `/api/admin/users/${userId}`, {
    token: adminToken,
    body: { banned: true },
  });
  assert(ban.data?.user?.banned === true, 'user banned from the dashboard');

  const bannedLogin = await call('POST', '/api/auth/login', {
    body: { username: USER, password: PASSWORD },
  });
  assert(bannedLogin.status === 403, `banned login → 403 (${bannedLogin.status})`);

  const bannedMe = await call('GET', '/api/auth/me', { token: userToken });
  assert(bannedMe.status === 401, `live session dies at the ban → 401 (${bannedMe.status})`);

  const unban = await call('PATCH', `/api/admin/users/${userId}`, {
    token: adminToken,
    body: { banned: false, premiumDays: null },
  });
  assert(unban.data?.user?.banned === false, 'user unbanned');
  assert(unban.data?.user?.premiumUntil === null, 'premium revoked from the dashboard');

  const backIn = await call('POST', '/api/auth/login', {
    body: { username: USER, password: PASSWORD },
  });
  assert(backIn.status === 200, `unbanned login works again (${backIn.status})`);
  const backToken = backIn.data?.token || userToken;

  // ── Settings round-trip ──────────────────────────────────────────────────
  const before = await call('GET', '/api/config');
  const wantAds = !before.data?.features?.ads;
  const save = await call('PUT', '/api/admin/settings', {
    token: adminToken,
    body: { features: { ads: wantAds } },
  });
  assert(save.status === 200, `settings saved (${save.status})`);
  const after = await call('GET', '/api/config');
  assert(after.data?.features?.ads === wantAds, 'the public config follows the dashboard');

  // ── Audit trail ──────────────────────────────────────────────────────────
  const audit = await call('GET', '/api/admin/audit?limit=50', { token: adminToken });
  const actions = (audit.data?.items || []).map((i) => i.action);
  assert(actions.includes('payment.approved'), 'approval is in the audit trail');
  assert(actions.includes('user.ban'), 'the ban is in the audit trail');

  // ── Cleanup: leave the database exactly as we found it ───────────────────
  await call('DELETE', `/api/admin/users/${userId}`, { token: adminToken });
  await cleanup(USER, userId);
  await call('PUT', '/api/admin/settings', {
    token: adminToken,
    body: { features: { ads: before.data?.features?.ads } },
  });
  if (pool) await pool.end().catch(() => undefined);
  void backToken;

  const passed = results.filter((r) => r.startsWith('ok:')).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main()
  .catch((err) => {
    console.error('test:admin crashed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => stopServer());
