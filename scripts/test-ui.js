/**
 * UI smoke for the social shell — every tab renders signed-in, with no
 * runtime errors, and the shell keeps its navigation contract.
 *
 *   npm run test:ui          (server must be running; needs system Chromium)
 *
 * The heavy WebRTC path is `test:e2e`; this one exists to catch the cheap
 * mistakes a build cannot — a page that throws on mount, a tab that lost its
 * route, a protected page that leaves a signed-out visitor staring at nothing.
 *
 * It registers a throwaway account over the API and deletes it afterwards.
 */
const path = require('path');
const fs = require('fs');
const puppeteer = require(path.join(__dirname, 'node_modules', 'puppeteer-core'));

const APP = process.env.APP_URL || 'http://localhost:4000';
const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';
const TOKEN_KEY = 'matchup.token';

const results = [];
const ok = (m) => { results.push('ok: ' + m); console.log('ok: ' + m); };
const bad = (m) => { results.push('FAIL: ' + m); console.error('FAIL: ' + m); };
const assert = (cond, m) => (cond ? ok(m) : bad(m));

/** route → text that must be on screen once signed in. */
const ROUTES = [
  ['/', 'Feed'],
  ['/explore', 'Explore'],
  ['/live', 'rooms'],
  ['/wallet', 'wallet'],
  ['/create', 'Create a post'],
  ['/settings', 'Payments'],
];

/** Console noise that is not the page's fault (favicon, cancelled fetches). */
const IGNORABLE = /favicon|Failed to load resource|net::ERR|401|404/i;

let created = null;

async function register() {
  const username = `uitest_${Date.now().toString(36)}`;
  const res = await fetch(`${APP}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password: 'uitest-password-123',
      profile: {
        username,
        age: 22,
        gender: 'other',
        country: 'KE',
        preferredGenders: ['any'],
        ageMin: 18,
        ageMax: 60,
      },
    }),
  });
  const data = await res.json();
  if (res.status !== 201) {
    throw new Error(`register → ${res.status} ${JSON.stringify(data)}`);
  }
  created = { username, id: data?.user?.id ?? null };
  return data.token;
}

/** Delete whatever this suite created (MariaDB only — memory mode needs no cleanup). */
async function cleanup(username) {
  let mysql;
  try {
    mysql = require(require.resolve('mysql2/promise', {
      paths: [path.join(__dirname, '..', 'server')],
    }));
  } catch {
    return;
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
    // Sessions, profiles, social rows and wallets cascade off the account.
    const [res] = await conn.query('DELETE FROM accounts WHERE username = ?', [username]);
    if (res.affectedRows) console.log(`cleanup: removed test account "${username}"`);
    // Sweep rows from earlier crashed runs (> 1h old, never a live test).
    const [stale] = await conn.query(
      `DELETE FROM accounts
        WHERE username LIKE 'uitest_%'
          AND created_at < NOW() - INTERVAL 1 HOUR`,
    );
    if (stale.affectedRows) console.log(`cleanup: swept ${stale.affectedRows} stale test account(s)`);
  } catch (err) {
    console.error('cleanup failed:', err.message);
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
  if (!fs.existsSync(CHROME)) {
    console.error(`no Chromium at ${CHROME} — set CHROME_PATH`);
    process.exit(2);
  }

  const token = await register();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-fake-device-for-media-stream'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  for (const [route, marker] of ROUTES) {
    errors.length = 0;
    // Land first, then sign in the way the app does, then come back — the
    // shell reads the token on mount.
    await page.goto(APP + route, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.evaluate((k, t) => localStorage.setItem(k, t), TOKEN_KEY, token);
    await page.goto(APP + route, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1200));
    const text = await page.evaluate(() => document.body.innerText);
    assert(text.toLowerCase().includes(marker.toLowerCase()), `${route} renders "${marker}"`);
    const real = errors.filter((e) => !IGNORABLE.test(e));
    assert(
      real.length === 0,
      `${route} has no runtime errors ${real.length ? JSON.stringify(real.slice(0, 3)) : ''}`,
    );
  }

  // The tab bar is the site map: the flagship 1v1 app must be one tap away.
  await page.goto(APP, { waitUntil: 'networkidle2', timeout: 30000 });
  const tabs = await page.$$eval('nav a', (as) => as.map((a) => a.getAttribute('href')));
  assert(
    ['/', '/explore', '/live', '/match', '/wallet', '/profile'].every((h) => tabs.includes(h)),
    `nav carries every tab (${JSON.stringify(tabs)})`,
  );

  // Signed out: the public feed still reads, and a protected page asks for
  // credentials instead of showing an empty shell.
  await page.evaluate((k) => localStorage.removeItem(k), TOKEN_KEY);
  await page.goto(APP, { waitUntil: 'networkidle2', timeout: 30000 });
  const feedOut = await page.evaluate(() => document.body.innerText);
  assert(feedOut.includes('Feed'), 'the feed reads signed out');
  await page.goto(APP + '/wallet', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 800));
  const walletOut = await page.evaluate(() => document.body.innerText);
  assert(/sign in|log in|password/i.test(walletOut), 'the wallet asks a signed-out visitor to sign in');

  await browser.close();
  if (created) await cleanup(created.username);
  const passed = results.filter((r) => r.startsWith('ok:')).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('test:ui crashed:', err.message);
  process.exit(1);
});
