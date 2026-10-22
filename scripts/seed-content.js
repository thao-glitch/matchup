/**
 * Seed the feed with real photographic content, through the real API.
 *
 *   npm run seed                (server must be running; re-run is safe)
 *
 * Every image in `scripts/seed-images/` is uploaded with `POST /api/media`
 * and published with `POST /api/posts` — exactly the flow the app itself
 * uses — so the rows the feed, explore and post pages render afterwards are
 * ordinary posts: some free (mediaUrl handed to anyone), some priced (media
 * withheld until a charge settles). Nothing is written behind the API's back.
 *
 * The four creators are ordinary registered accounts with a fixed, public
 * password (`SEED_PASSWORD`) so the owner can sign in and manage them from
 * the admin panel like any other account. A creator that already has posts
 * is skipped, so re-running the script never duplicates content.
 *
 * Interrupted test runs leave their own accounts (and junk posts) behind —
 * the suites' cleanup never reached its DELETEs. This script doubles as the
 * broom and sweeps those stale rows first, so `npm run seed` always ends with
 * a feed that contains exactly the content below.
 *
 * Publishing, liking and commenting share one 30/min rate bucket on the
 * server, so every call retries once after a 429 rather than racing it.
 */
const fs = require('fs');
const path = require('path');

const APP = process.env.APP_URL || 'http://localhost:4000';
const SEED_PASSWORD = process.env.SEED_PASSWORD || 'seed-account-2026';
const IMAGE_DIR = path.join(__dirname, 'seed-images');

/** The demo creators: username → profile + the posts they publish. */
const CREATORS = [
  {
    username: 'wander_ke',
    profile: { age: 27, gender: 'other', country: 'KE' },
    posts: [
      { file: 'safari.jpg', caption: 'First light over the Mara 🦁 nothing beats golden hour on the road', price: 0 },
      { file: 'travel.jpg', caption: 'Packing list for the next trip — passport, one lens, zero plans ✈️', price: 120 },
      { file: 'beach.jpg', caption: 'Coral gardens off the south coast. Snorkel season is on 🐠', price: 0 },
    ],
  },
  {
    username: 'naija_bites',
    profile: { age: 31, gender: 'other', country: 'NG' },
    posts: [
      { file: 'food.jpg', caption: 'Small-chop spread for the weekend table — which plate are you starting with? 🍗',
        price: 0 },
      { file: 'city-night.jpg', caption: 'The city after midnight — full set of night shots on the shelf 🌃', price: 80 },
    ],
  },
  {
    username: 'studio_mtaa',
    profile: { age: 24, gender: 'other', country: 'KE' },
    posts: [
      { file: 'music-studio.jpg', caption: 'New session in the booth — stems drop for supporters tonight 🎧', price: 200 },
      { file: 'coffee.jpg', caption: 'Cortado and a clean arrangement. Slow mornings make better records ☕', price: 0 },
    ],
  },
  {
    username: 'city_roams',
    profile: { age: 29, gender: 'other', country: 'US' },
    posts: [
      { file: 'aerial-city.jpg', caption: 'Caught the whole grid from the ridge trail at dusk 🌆', price: 0 },
      { file: 'crew.jpg', caption: 'The group chat finally agreed on a date. Save-the-day drop 🎉', price: 60 },
      { file: 'party.jpg', caption: 'Balloons up — thank you for 10k. Free pack for everyone today 🎈', price: 0 },
    ],
  },
];

/** Small talk between the creators, so the pages under the feed aren't bare. */
const INTERACTIONS = [
  { on: ['naija_bites', 'food.jpg'], by: 'wander_ke', like: true, comment: 'That first plate is gone in seconds 😄' },
  { on: ['studio_mtaa', 'music-studio.jpg'], by: 'naija_bites', like: true, comment: 'Need this on streaming 🙌' },
  { on: ['wander_ke', 'safari.jpg'], by: 'studio_mtaa', like: true },
  { on: ['city_roams', 'aerial-city.jpg'], by: 'wander_ke', like: true, comment: 'Which trail is this?' },
  { on: ['wander_ke', 'beach.jpg'], by: 'city_roams', like: true },
  { on: ['city_roams', 'crew.jpg'], by: 'studio_mtaa', like: true },
];

// ── HTTP ────────────────────────────────────────────────────────────────────

/** One API call; a 429 (the shared 30/min content bucket) waits it out once. */
async function call(method, route, { body, raw, contentType, token } = {}) {
  const send = () =>
    fetch(`${APP}${route}`, {
      method,
      headers: {
        // Raw uploads must carry their real MIME type: the global 32kb JSON
        // parser ignores anything that isn't application/json, and the media
        // route reads the header to pick the stored file's extension.
        ...(raw !== undefined
          ? { 'content-type': contentType || 'application/octet-stream' }
          : body === undefined
            ? {}
            : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });

  let res = await send();
  if (res.status === 429) {
    process.stdout.write('  rate limit — waiting a minute…\n');
    await new Promise((r) => setTimeout(r, 61_000));
    res = await send();
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
  return { status: res.status, data, error: data?.error?.message ?? null };
}

// ── Accounts ────────────────────────────────────────────────────────────────

async function signIn(creator) {
  const profile = { username: creator.username, preferredGenders: ['any'], ageMin: 18, ageMax: 60, ...creator.profile };
  const login = await call('POST', '/api/auth/login', {
    body: { username: creator.username, password: SEED_PASSWORD },
  });
  if (login.status === 200) return { token: login.data.token, fresh: false };

  const reg = await call('POST', '/api/auth/register', {
    body: { username: creator.username, password: SEED_PASSWORD, profile },
  });
  if (reg.status !== 201) {
    throw new Error(`register ${creator.username} → ${reg.status} ${reg.error ?? ''}`);
  }
  return { token: reg.data.token, fresh: true };
}

// ── The seed itself ─────────────────────────────────────────────────────────

/**
 * Sweep test-litter accounts (`tcr*`/`tby*`/`tadm*` from test:platform,
 * `e2e_*` from test:e2e) left behind by interrupted runs — the same shapes
 * the suites generate, matched exactly so a real account is never touched.
 * Only rows older than an hour go: a suite running right now stays intact.
 *
 * Money and social rows carry no FK on purpose, so they are deleted by hand
 * (oldest first); sessions and passport rows cascade off the account.
 */
async function sweepStaleLitter() {
  let mysql;
  try {
    mysql = require(require.resolve('mysql2/promise', { paths: [path.join(__dirname, '..', 'server')] }));
  } catch {
    return; // no driver (memory-mode checkout) — nothing to sweep
  }
  const env = { ...process.env };
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
    const [stale] = await conn.query(
      `SELECT id FROM accounts
        WHERE (username REGEXP '^tcr[0-9a-z]{5}$'
            OR username REGEXP '^tby[0-9a-z]{5}$'
            OR username REGEXP '^tadm[0-9a-z]{5}$'
            OR username REGEXP '^e2e_[0-9a-z]+$')
          AND created_at < NOW() - INTERVAL 1 HOUR`,
    );
    const ids = stale.map((r) => Number(r.id));
    if (!ids.length) return;
    const ph = ids.map(() => '?').join(',');
    const money = [...ids, ...ids]; // charges match on buyer OR payee
    const tables = [
      [`DELETE FROM posts WHERE account_id IN (${ph})`, ids],
      [`DELETE FROM charges WHERE buyer_account_id IN (${ph}) OR payee_account_id IN (${ph})`, money],
      [`DELETE FROM wallet_entries WHERE account_id IN (${ph})`, ids],
      [`DELETE FROM wallets WHERE account_id IN (${ph})`, ids],
      [`DELETE FROM rooms WHERE host_account_id IN (${ph})`, ids],
      [`DELETE FROM post_comments WHERE account_id IN (${ph})`, ids],
      [`DELETE FROM post_likes WHERE account_id IN (${ph})`, ids],
      [`DELETE FROM accounts WHERE id IN (${ph})`, ids], // sessions + passport cascade
    ];
    for (const [sql, params] of tables) await conn.query(sql, params);
    console.log(`swept ${ids.length} stale test account(s) left by interrupted runs`);
  } catch (err) {
    console.error('litter sweep failed:', err.message);
  } finally {
    await conn.end().catch(() => undefined);
  }
}

async function main() {
  const health = await fetch(`${APP}/health`).then((r) => r.status).catch(() => 0);
  if (health !== 200) {
    console.error(`no server answering at ${APP} — start it first`);
    process.exit(2);
  }
  const images = fs.readdirSync(IMAGE_DIR).filter((f) => f.endsWith('.jpg'));
  if (!images.length) {
    console.error(`no .jpg files in ${IMAGE_DIR}`);
    process.exit(2);
  }

  await sweepStaleLitter();

  const tokens = {};
  const published = []; // { creator, caption, price, id } for the checks below

  for (const creator of CREATORS) {
    // A creator who already posted means this run's content is in — skip them.
    const { token, fresh } = await signIn(creator);
    tokens[creator.username] = token;
    const mine = await call('GET', '/api/posts/mine', { token });
    const existing = mine.status === 200 ? (mine.data.items?.length ?? 0) : 0;
    if (existing > 0) {
      console.log(`skip: @${creator.username} already has ${existing} post(s)`);
      // Record the *real* ids of what's already there: with `id: null` a
      // re-run would filter the feed down to zero rows and report "ok (0)"
      // without checking anything. `file` stays null so these never match an
      // INTERACTIONS key — engagement below only applies to fresh publishes.
      for (const item of mine.data.items || []) {
        published.push({ creator: creator.username, file: null, id: item.id, price: item.price });
      }
      continue;
    }
    console.log(`${fresh ? 'created' : 'signed in'}: @${creator.username}`);

    for (const post of creator.posts) {
      const bytes = fs.readFileSync(path.join(IMAGE_DIR, post.file));
      const up = await call('POST', '/api/media', { raw: bytes, contentType: 'image/jpeg', token });
      if (up.status !== 201) throw new Error(`upload ${post.file} → ${up.status} ${up.error ?? ''}`);

      const made = await call('POST', '/api/posts', {
        body: { type: 'image', caption: post.caption, price: post.price, isAdult: false, mediaKey: up.data.key },
        token,
      });
      if (made.status !== 201) throw new Error(`post ${post.file} → ${made.status} ${made.error ?? ''}`);
      published.push({ creator: creator.username, file: post.file, id: made.data.post.id });
      console.log(
        `  + ${post.file} → post #${made.data.post.id} (${post.price ? `KES ${post.price}` : 'free'})`,
      );
    }
  }

  // Light, real-API engagement: cross-likes and a few comments between the
  // creators, exactly as the apps' own buttons would send them.
  const byId = new Map(
    published.filter((p) => p.id).map((p) => [`${p.creator}|${p.file}`, p.id]),
  );
  let likes = 0;
  let comments = 0;
  for (const rule of INTERACTIONS) {
    const id = byId.get(`${rule.on[0]}|${rule.on[1]}`);
    if (!id || !tokens[rule.by]) continue;
    if (rule.like) {
      const liked = await call('POST', `/api/posts/${id}/like`, { body: { liked: true }, token: tokens[rule.by] });
      if (liked.status === 200) likes += 1;
    }
    if (rule.comment) {
      const said = await call('POST', `/api/posts/${id}/comments`, { body: { body: rule.comment }, token: tokens[rule.by] });
      if (said.status === 201) comments += 1;
    }
  }

  // Count a view on each post this run actually published, the way a visitor
  // would: by opening it. Re-runs skip this so repeat seeding never inflates
  // the counter on content that was already there.
  for (const p of published) {
    if (p.id && p.file) await call('GET', `/api/posts/${p.id}`);
  }

  // ── Verify the flow end to end ──────────────────────────────────────────
  // Signed out, the feed must hand back free posts with a media URL and keep
  // priced ones locked (mediaUrl null) — the paywall contract on the wire.
  const feed = await call('GET', '/api/posts?size=50');
  if (feed.status !== 200) throw new Error(`feed → ${feed.status}`);
  const seededIds = new Set(published.map((p) => p.id).filter(Boolean));
  const rows = (feed.data.items || []).filter((r) => seededIds.has(r.id));
  const free = rows.filter((r) => r.price === 0);
  const paid = rows.filter((r) => r.price > 0);
  const freeOpen = free.every((r) => typeof r.mediaUrl === 'string' && r.mediaUrl.length > 0);
  const paidLocked = paid.every((r) => r.mediaUrl === null);

  // The creator's own view: a priced post they wrote must come back owned and
  // carrying its media, or their profile shows a locked card of their own work
  // with no thumbnail. This is the list route's half of the paywall contract —
  // `test:platform` asserts the same ownership flag on text posts, but only
  // these seeded photographs can prove the URL is handed over.
  const withPaid = CREATORS.find((c) => c.posts.some((p) => p.price > 0));
  const mine = await call('GET', '/api/posts/mine?size=50', { token: tokens[withPaid.username] });
  const ownPaid = (mine.data?.items || []).find((p) => p.price > 0);
  const creatorSeesMedia =
    mine.status === 200 &&
    Boolean(ownPaid) &&
    ownPaid.owned === true &&
    typeof ownPaid.mediaUrl === 'string' &&
    ownPaid.mediaUrl.length > 0;

  // …and that URL must load with no Authorization header at all: an <img> tag
  // cannot send one, so a paid `mediaUrl` carries a signed `?t=` claim
  // (see server/src/mediaToken.js) and the media route accepts it alone.
  const bare = creatorSeesMedia ? await call('GET', ownPaid.mediaUrl) : { status: 0 };
  const claimLoads = bare.status === 200;

  console.log('');
  console.log(`seeded: ${rows.length} post(s) from ${CREATORS.length} creators, ${likes} like(s), ${comments} comment(s)`);
  console.log(`  free posts open to anyone: ${freeOpen ? 'ok' : 'FAIL'} (${free.length})`);
  console.log(`  priced posts stay locked:  ${paidLocked ? 'ok' : 'FAIL'} (${paid.length})`);
  console.log(`  creator sees own paid media: ${creatorSeesMedia ? 'ok' : 'FAIL'}`);
  console.log(`  paid URL loads without a header: ${claimLoads ? 'ok' : 'FAIL'}`);
  if (!freeOpen || !paidLocked || !creatorSeesMedia || !claimLoads) process.exit(1);
}

main().catch((err) => {
  console.error('seed failed:', err.message);
  process.exit(1);
});
