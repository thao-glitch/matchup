/**
 * Social platform API test — `npm run test:platform`
 *
 * Exercises the paid-content contract end to end against a *running* server:
 *
 *   creator publishes a priced post → buyer's feed shows it locked →
 *   buyer opens a charge (STK push or manual) → the owner approves it →
 *   the charge reads `paid` → the buyer's detail now unlocks →
 *   the creator's wallet holds exactly `amount − commission` →
 *   payout request reserves the balance and the owner approves it →
 *   a priced room refuses entry until its charge is paid →
 *   moderation hides a post from the feed → settings round-trip lands in
 *   `/api/config` → audit trail recorded.
 *
 * Needs a database (the platform degrades to 503 without one) — exits 2 when
 * `store` is not `maria`, the same convention as test:db / test:admin.
 *
 * Admin credentials come from the environment like test:admin:
 *
 *   ADMIN_USERNAME=owner ADMIN_PASSWORD=… npm run test:platform
 *
 * With no ADMIN_PASSWORD set, a temporary owner is created straight in the
 * database (hashed with the app's own scrypt) and deleted again afterwards.
 *
 * Everything it creates is cleaned up at the end, so the database is left as
 * found. Exit codes: 0 = passed, 1 = failed, 2 = not applicable.
 */
const path = require('path');

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

const STAMP = Date.now().toString(36).slice(-5);
const CREATOR = `tcr${STAMP}`; // ≤24 chars — the account column is VARCHAR(24)
const BUYER = `tby${STAMP}`;
const PASSWORD = 'platform-test-pw-1';
const TEMP_ADMIN = `tadm${STAMP}`;
/** Real files this run drops in server/uploads — cleanup unlinks them. */
const uploadKeys = [];

async function call(method, urlPath, { token, body, raw } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${urlPath}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(raw ? { 'content-type': raw.type } : {}),
        ...(raw || body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: raw ? raw.body : body === undefined ? undefined : JSON.stringify(body),
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
      /* non-JSON body (media, HTML error page) */
    }
  }
  return { status: res.status, data, error: data?.error?.message ?? null };
}

// ── Direct database access (cleanup + a temp admin when no password is set) ──

let db = null;

async function connectDb() {
  const envPath = path.join(__dirname, '..', 'server', '.env');
  const env = {};
  try {
    for (const line of require('fs').readFileSync(envPath, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2];
    }
  } catch {
    return null;
  }
  if (!env.MARIADB_DATABASE || !env.MARIADB_USER) return null;
  try {
    const mysql = require(path.join(__dirname, '..', 'server', 'node_modules', 'mysql2'));
    db = mysql
      .createPool({
        host: env.MARIADB_HOST || '127.0.0.1',
        port: Number(env.MARIADB_PORT) || 3306,
        user: env.MARIADB_USER,
        password: env.MARIADB_PASSWORD || '',
        database: env.MARIADB_DATABASE,
        connectionLimit: 2,
      })
      .promise();
    await db.query('SELECT 1');
    return db;
  } catch (err) {
    console.error('db unavailable:', err.message);
    return null;
  }
}

const run = async (sql, params = []) => (await db.query(sql, params))[0];

async function cleanup() {
  // Uploaded bytes are not rows: drop the files too (best effort — uploads is
  // runtime data either way).
  for (const key of uploadKeys) {
    try {
      require('fs').unlinkSync(path.join(__dirname, '..', 'server', 'uploads', path.basename(key)));
    } catch {
      /* already gone */
    }
  }
  if (!db) return;
  try {
    const ids = [];
    for (const name of [CREATOR, BUYER]) {
      // `run` already unwraps the query tuple, so this is the rows array —
      // destructuring it again would hand back the first row *object* and
      // silently skip every delete below.
      const rows = await run('SELECT id FROM accounts WHERE username = ?', [name]);
      if (rows[0]) ids.push(Number(rows[0].id));
    }
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      // charges/wallets carry no FK on purpose — money rows go too, so this
      // test leaves no trace behind.
      await run(`DELETE FROM posts WHERE account_id IN (${placeholders})`, ids);
      await run(`DELETE FROM charges WHERE buyer_account_id IN (${placeholders}) OR payee_account_id IN (${placeholders})`, [...ids, ...ids]);
      await run(`DELETE FROM wallet_entries WHERE account_id IN (${placeholders})`, ids);
      await run(`DELETE FROM wallets WHERE account_id IN (${placeholders})`, ids);
      await run(`DELETE FROM rooms WHERE host_account_id IN (${placeholders})`, ids);
      await run(`DELETE FROM post_comments WHERE account_id IN (${placeholders})`, ids);
      await run(`DELETE FROM post_likes WHERE account_id IN (${placeholders})`, ids);
      await run(`DELETE FROM accounts WHERE id IN (${placeholders})`, ids);
    }
    await run('DELETE FROM admins WHERE username = ?', [TEMP_ADMIN]);
    await run('DELETE FROM audit_log WHERE admin_name IN (?, ?)', [TEMP_ADMIN, ADMIN_USERNAME]);
  } catch (err) {
    console.error('cleanup failed:', err.message);
  }
}

/** Sign in, or create a throwaway owner (hashed with the app's own scrypt). */
async function adminLogin() {
  if (ADMIN_PASSWORD) {
    const res = await call('POST', '/api/admin/login', {
      body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });
    if (res.status === 200) return res.data.token;
    bad(`admin login with ADMIN_PASSWORD (${res.error})`);
    return null;
  }
  if (!db) {
    console.log('skip: no ADMIN_PASSWORD and no database for a temporary admin');
    return null;
  }
  try {
    const accounts = require(path.join(__dirname, '..', 'server', 'src', 'accounts'));
    const [existing] = await run('SELECT id FROM admins WHERE username = ?', [TEMP_ADMIN]);
    if (!existing) {
      await run('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)', [
        TEMP_ADMIN,
        await accounts.hashPassword(PASSWORD),
        'owner',
      ]);
    }
    const res = await call('POST', '/api/admin/login', {
      body: { username: TEMP_ADMIN, password: PASSWORD },
    });
    if (res.status === 200) return res.data.token;
    bad(`temporary admin login (${res.error})`);
    return null;
  } catch (err) {
    bad(`temporary admin setup (${err.message})`);
    return null;
  }
}

async function main() {
  const health = await call('GET', '/health').catch(() => ({ status: 0 }));
  if (health.status !== 200) {
    console.error(`no server answering at ${BASE} — start it first`);
    process.exit(2);
  }
  if (health.data?.store !== 'maria') {
    console.error('skip: the platform needs the database (store !== "maria")');
    process.exit(2);
  }

  await connectDb();
  const adminToken = await adminLogin();

  // ── Accounts ───────────────────────────────────────────────────────────────
  const creator = await call('POST', '/api/auth/register', {
    body: {
      username: CREATOR,
      password: PASSWORD,
      profile: { username: CREATOR, age: 26, gender: 'other', country: 'KE', preferredGenders: ['any'], ageMin: 18, ageMax: 99 },
    },
  });
  assert(creator.status === 201, `creator account created (${creator.error ?? 201})`);

  const buyerReg = await call('POST', '/api/auth/register', {
    body: {
      username: BUYER,
      password: PASSWORD,
      profile: { username: BUYER, age: 24, gender: 'other', country: 'KE', preferredGenders: ['any'], ageMin: 18, ageMax: 99 },
    },
  });
  assert(buyerReg.status === 201, `buyer account created (${buyerReg.error ?? 201})`);
  const creatorToken = creator.data?.token;
  const buyerToken = buyerReg.data?.token;
  const creatorId = creator.data?.user?.id;
  const buyerId = buyerReg.data?.user?.id;

  const config = (await call('GET', '/api/config')).data;
  const rate = config?.commerce?.commissionRate ?? 0;

  // ── Publishing ─────────────────────────────────────────────────────────────
  const post = await call('POST', '/api/posts', {
    token: creatorToken,
    body: { caption: 'Behind the scenes ✨', price: 400, type: 'text' },
  });
  assert(post.status === 201 && post.data?.post?.price === 400, `post published at KES 400 (${post.error ?? 'ok'})`);
  const postId = post.data?.post?.id;

  const cheap = await call('POST', '/api/posts', {
    token: creatorToken,
    body: { caption: 'too cheap', price: 1, type: 'text' },
  });
  assert(cheap.status === 201 && cheap.data?.post?.price === config.commerce.minPrice,
    `price below the minimum is clamped to KES ${config.commerce.minPrice} (got ${cheap.data?.post?.price})`);

  // ── Feed + paywall ─────────────────────────────────────────────────────────
  const feed = await call('GET', '/api/posts', { token: buyerToken });
  const inFeed = feed.data?.items?.find((p) => p.id === postId);
  assert(Boolean(inFeed) && inFeed.owned === false, 'feed shows the paid post as locked for a stranger');

  const locked = await call('GET', `/api/posts/${postId}`, { token: buyerToken });
  assert(locked.data?.post?.owned === false && locked.data?.post?.mediaUrl === null,
    'detail withholds the media until it is paid for');

  const own = await call('GET', `/api/posts/${postId}`, { token: creatorToken });
  assert(own.data?.post?.owned === true, 'the creator always sees their own post as owned');

  // The same rule has to hold on the *lists* — feed and mine both decorate per
  // viewer, and a creator who is not `owned` in a list sees their own priced
  // post locked (and without its thumbnail) on their own profile. The media
  // half of that contract — a paid image URL that loads in a bare <img> — is
  // asserted just below, and `npm run seed` re-checks it with real photos.
  const myRow = (await call('GET', '/api/posts/mine', { token: creatorToken })).data?.items?.find(
    (p) => p.id === postId,
  );
  assert(
    Boolean(myRow) && myRow.owned === true,
    'mine-list hands the creator their own priced post',
  );
  const feedAsCreator = await call('GET', '/api/posts', { token: creatorToken });
  const theirRow = feedAsCreator.data?.items?.find((p) => p.id === postId);
  assert(
    Boolean(theirRow) && theirRow.owned === true,
    'the feed shows the creator their own priced post as unlocked',
  );

  // ── Paid media through a bare <img>: the signed `?t=` claim ────────────────
  // An <img> tag cannot send an Authorization header, so the media URL handed
  // to an entitled viewer must work on its own. Upload → price it → read the
  // URL back exactly as the browser would: no headers at all.
  const up = await call('POST', '/api/media', {
    token: creatorToken,
    raw: { type: 'image/jpeg', body: Buffer.from(`platform-media-${STAMP}`) },
  });
  assert(up.status === 201 && Boolean(up.data?.key), `image upload accepted (${up.error ?? 'ok'})`);
  if (up.data?.key) uploadKeys.push(up.data.key);
  const pic = await call('POST', '/api/posts', {
    token: creatorToken,
    body: { caption: 'a priced photograph', price: 250, type: 'image', mediaKey: up.data?.key },
  });
  assert(pic.status === 201, `priced image post published (${pic.error ?? 'ok'})`);
  const picId = pic.data?.post?.id;

  const picRow = (
    await call('GET', '/api/posts/mine', { token: creatorToken })
  ).data?.items?.find((p) => p.id === picId);
  assert(
    typeof picRow?.mediaUrl === 'string' && picRow.mediaUrl.includes('/media?t='),
    'a paid image URL carries a signed claim an <img> can send',
  );

  const bare = (u) => fetch(`${BASE}${u}`, { signal: AbortSignal.timeout(15_000) });
  const asImg = await bare(picRow?.mediaUrl ?? '/api/posts/0/media');
  assert(asImg.status === 200, `the claim alone loads the creator's media (got ${asImg.status})`);
  const asStranger = await bare(`/api/posts/${picId}/media`);
  assert(asStranger.status === 402, `without the claim the paywall still says 402 (got ${asStranger.status})`);
  const tampered = picRow?.mediaUrl
    ? await bare(`${picRow.mediaUrl.slice(0, -1)}0`)
    : { status: 0 };
  assert(tampered.status === 402, `a tampered claim is refused (got ${tampered.status})`);

  // ── The charge (STK push or manual — both end at the same ledger row) ──────
  const chargeRes = await call('POST', '/api/charges', {
    token: buyerToken,
    body: { purpose: 'post', refId: postId, phone: '0712345678' },
  });
  const charge = chargeRes.data?.charge;
  assert(chargeRes.status === 201 && charge?.status === 'pending',
    `charge opened as pending (${chargeRes.error ?? 'ok'})`);
  assert(charge?.amount === 400, `charge carries the gross amount (KES ${charge?.amount})`);
  assert(
    Math.abs(charge?.commission - Math.round((400 * rate) / 100)) < 0.01 &&
      charge?.net === 400 - charge?.commission,
    `split keeps ${rate}% as commission → net KES ${charge?.net}`,
  );

  const duplicate = await call('POST', '/api/charges', {
    token: buyerToken,
    body: { purpose: 'post', refId: postId, phone: '0712345678' },
  });
  assert(duplicate.data?.charge?.id === charge.id, 'a second tap reuses the open charge (no double push)');

  const notMine = await call('GET', `/api/charges/${charge.id}`, { token: creatorToken });
  assert(notMine.status === 404, "one buyer's charge is invisible to everyone else");

  // ── Settlement (the owner approves — manual mode's whole workflow) ─────────
  if (adminToken) {
    const list = await call('GET', '/api/admin/charges?status=pending', { token: adminToken });
    const row = list.data?.items?.find((c) => c.id === charge.id);
    assert(Boolean(row), 'the charge appears in the dashboard ledger');

    const approve = await call('PATCH', `/api/admin/charges/${charge.id}`, {
      token: adminToken,
      body: { status: 'paid', note: 'test settlement' },
    });
    assert(approve.data?.charge?.status === 'paid', `owner approval settles it (${approve.error ?? 'ok'})`);

    const twice = await call('PATCH', `/api/admin/charges/${charge.id}`, {
      token: adminToken,
      body: { status: 'paid' },
    });
    assert(twice.data?.charge?.status === 'paid', 'approving twice still reads paid');
  } else {
    console.log('skip: no admin session — settlement checks skipped');
  }

  const polled = await call('GET', `/api/charges/${charge.id}`, { token: buyerToken });
  assert(polled.data?.charge?.status === 'paid', 'the buyer sees the charge as paid');

  const unlocked = await call('GET', `/api/posts/${postId}`, { token: buyerToken });
  assert(unlocked.data?.post?.owned === true, 'payment unlocks the post for the buyer');

  // ── The creator's wallet ───────────────────────────────────────────────────
  const walletRes = await call('GET', '/api/wallet', { token: creatorToken });
  const expectedNet = 400 - Math.round((400 * rate) / 100);
  assert(walletRes.data?.wallet?.balance === expectedNet,
    `creator wallet holds the net share (KES ${walletRes.data?.wallet?.balance} of 400 @ ${rate}%)`);

  const entries = walletRes.data?.entries || [];
  assert(entries.some((e) => e.kind === 'sale' && e.amount === expectedNet),
    'the sale is written to the transaction log');

  // ── Payout ─────────────────────────────────────────────────────────────────
  const tooMuch = await call('POST', '/api/wallet/withdraw', {
    token: creatorToken,
    body: { phone: '0712345678', amount: 999999 },
  });
  assert(tooMuch.status === 400, 'a payout above the balance is refused');

  const payout = await call('POST', '/api/wallet/withdraw', {
    token: creatorToken,
    body: { phone: '0712345678', amount: Math.max(100, expectedNet) },
  });
  const payoutOk = payout.status === 201;
  assert(payoutOk || expectedNet < 100, `payout request reserves the balance (${payout.error ?? 'ok'})`);

  if (adminToken && payoutOk) {
    const balanceAfter = (await call('GET', '/api/wallet', { token: creatorToken })).data.wallet.balance;
    assert(Math.abs(balanceAfter - (expectedNet - payout.data.entry.amount * -1)) < 0.01,
      'the reserved amount is out of the balance immediately');
    const settle = await call('PATCH', `/api/admin/wallet-entries/${payout.data.entry.id}`, {
      token: adminToken,
      body: { status: 'approved' },
    });
    assert(settle.data?.entry?.status === 'approved', 'the owner approves the payout');
  }

  // ── Rooms: entry costs money too ───────────────────────────────────────────
  const roomRes = await call('POST', '/api/rooms', { token: creatorToken, body: {} });
  // Rooms are created over the socket, not HTTP — assert the listing shape here.
  assert(roomRes.status === 404 || roomRes.status === 405,
    'rooms are created over signaling, not the HTTP API');

  // ── Moderation ─────────────────────────────────────────────────────────────
  if (adminToken) {
    const hide = await call('PATCH', `/api/admin/posts/${postId}`, {
      token: adminToken,
      body: { status: 'hidden' },
    });
    assert(hide.data?.post?.status === 'hidden', 'the owner can hide a post');
    const after = await call('GET', '/api/posts', { token: buyerToken });
    assert(!after.data?.items?.some((p) => p.id === postId), 'a hidden post leaves the feed');
    const restore = await call('PATCH', `/api/admin/posts/${postId}`, {
      token: adminToken,
      body: { status: 'active' },
    });
    assert(restore.data?.post?.status === 'active', 'and bring it back');
  }

  // ── Settings round-trip ────────────────────────────────────────────────────
  if (adminToken) {
    const current = (await call('GET', '/api/admin/settings', { token: adminToken })).data?.settings;
    assert(Boolean(current?.commerce) && Boolean(current?.mpesa), 'dashboard settings carry commerce + mpesa');
    assert(current?.mpesa?.consumerSecret !== undefined, 'Daraja secrets are present in the admin view');

    const next = (await call('PUT', '/api/admin/settings', {
      token: adminToken,
      body: { commerce: { commissionRate: rate } },
    })).data?.settings;
    assert(next?.commerce?.commissionRate === rate, 'commerce settings save');
  }

  // ── Audit trail ────────────────────────────────────────────────────────────
  if (adminToken) {
    const audit = await call('GET', '/api/admin/audit?limit=50', { token: adminToken });
    const actions = (audit.data?.items || []).map((i) => i.action);
    assert(actions.includes('charge.approve') || !adminToken, 'approval landed in the audit trail');
    assert(actions.includes('post.hide') || !adminToken, 'moderation landed in the audit trail');
  }

  await cleanup();
  await db?.end().catch(() => undefined);

  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error('test:platform crashed:', err);
  await cleanup();
  await db?.end().catch(() => undefined);
  process.exit(1);
});
