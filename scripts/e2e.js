/**
 * Full-stack WebRTC E2E: two pages in a real Chromium, fake camera/mic,
 * matched through the signaling server, connected peer-to-peer.
 *
 *   npm run test:e2e
 *
 * Requires the built client (`npm run build`) — the server serves client/dist.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

const APP = process.env.APP_URL || 'http://localhost:4000';
/**
 * Production shape — frontend and server on *different* origins (Vercel site +
 * tunnelled server). `APP_URL` is what the browser navigates to; `API_URL` is
 * where /health and /api/stats live. They default to the same origin, so the
 * classic local run is unchanged:
 *
 *   APP_URL=https://your-app.vercel.app \
 *   API_URL=https://<tunnel>.trycloudflare.com \
 *   node scripts/e2e.js
 */
const API = process.env.API_URL || APP;
/**
 * `E2E_RELAY=1 npm run test:e2e` pins ICE to TURN (`?relay=1` in the app) and
 * additionally asserts that the media path really is `TURN relay` — the
 * end-to-end proof that the relay configured on the server works in a browser.
 * Requires TURN to be configured (see README → "Deploying TURN").
 */
const FORCE_RELAY = Boolean(process.env.E2E_RELAY);
const results = [];
const ok = (m) => { results.push('ok: ' + m); console.log('ok: ' + m); };
const bad = (m) => { results.push('FAIL: ' + m); console.error('FAIL: ' + m); };
const assert = (cond, m) => (cond ? ok(m) : bad(m));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ping() {
  // fetch (not http.get) so an https API — the tunnelled production server — works.
  try {
    const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(1500) });
    return res.status === 200;
  } catch {
    return false;
  }
}

let spawnedServer = null;

async function ensureServer() {
  const dist = path.join(__dirname, '..', 'client', 'dist', 'index.html');
  if (!fs.existsSync(dist)) {
    throw new Error('client/dist not found — run `npm run build` first');
  }
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
  throw new Error('signaling server did not start on :4000');
}

async function launchBrowser() {
  return puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      // Brave (the interactive browser) ships a WebRTC policy that gathers zero
      // candidates; force full interface discovery here.
      '--force-webrtc-ip-handling-policy=default_public_and_private_interfaces',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--allow-insecure-localhost',
      '--window-size=1280,800',
    ],
  });
}

async function join(page, profile) {
  await page.goto(FORCE_RELAY ? `${APP}/?relay=1` : APP, { waitUntil: 'load', timeout: 20000 });
  await page.waitForSelector('#username', { timeout: 10000 });
  await page.type('#username', profile.username);
  await page.select('#age', String(profile.age));
  await page.select('#gender', profile.gender);
  await page.select('#country', profile.country);
  // Preference chips are plain buttons — click the matching label.
  await page.$$eval(
    'button',
    (btns, label) => {
      const target = btns.find((b) => b.textContent.trim() === label);
      if (!target) throw new Error('preference chip not found: ' + label);
      target.click();
    },
    profile.prefLabel,
  );
  await page.$$eval('button', (btns) => {
    const target = btns.find((b) => b.textContent.includes('Start matching'));
    if (!target) throw new Error('submit button not found');
    target.click();
  });
}

const bodyText = (page) => page.evaluate(() => document.body.innerText.replace(/\n+/g, ' | '));

async function waitForText(page, pattern, timeout = 30000) {
  try {
    await page.waitForFunction(
      (re) => new RegExp(re).test(document.body.innerText),
      { timeout },
      pattern,
    );
    return true;
  } catch {
    return false;
  }
}

/** Click the first <button> whose text contains `text` (JS click — no scrolling). */
async function clickButton(page, text, exact = false) {
  await page.$$eval(
    'button',
    (btns, args) => {
      const target = btns.find((b) =>
        args.exact ? b.textContent.trim() === args.text : b.textContent.includes(args.text),
      );
      if (!target) throw new Error('button not found: ' + args.text);
      target.click();
    },
    { text, exact },
  );
}

async function videoState(page) {
  return page.evaluate(() => {
    const vids = [...document.querySelectorAll('video')];
    return vids.map((v) => ({
      src: Boolean(v.srcObject),
      w: v.videoWidth,
      h: v.videoHeight,
      paused: v.paused,
      muted: v.muted,
    }));
  });
}

async function main() {
  await ensureServer();
  const browser = await launchBrowser();
  try {
    const ctxA = await browser.createBrowserContext();
    const ctxB = await browser.createBrowserContext();
    const [pageA, pageB] = await Promise.all([ctxA.newPage(), ctxB.newPage()]);

    const consoleErrors = [];
    for (const [name, p] of [['A', pageA], ['B', pageB]]) {
      p.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(`${name}: ${m.text()}`);
      });
      p.on('pageerror', (e) => consoleErrors.push(`${name} pageerror: ${e.message}`));
    }

    // ── 1. Lobby ─────────────────────────────────────────────────────────────
    await join(pageA, {
      username: 'alice', age: 24, gender: 'female', country: 'KE', prefLabel: 'Men',
    });
    const aWaiting = await waitForText(pageA, 'Looking for someone', 10000);
    assert(aWaiting, 'A reaches the waiting screen after granting media');

    await join(pageB, {
      username: 'bob', age: 27, gender: 'male', country: 'DE', prefLabel: 'Women',
    });
    // B may be matched the instant it queues (A is already waiting), so it can
    // legitimately skip the waiting screen. Accept either state — just not
    // "still stuck on the lobby form".
    const bWaiting = await waitForText(pageB, 'Looking for someone', 10000);
    const bInstant = bWaiting ? true : await waitForText(pageB, 'End call', 15000);
    assert(bWaiting || bInstant, 'B leaves the lobby (waiting screen or instant match)');

    // ── 2. Match + WebRTC handshake ──────────────────────────────────────────
    const aMatched = await waitForText(pageA, 'End call', 20000);
    const bMatched = await waitForText(pageB, 'End call', 20000);
    assert(aMatched, 'A was matched (call screen shown)');
    assert(bMatched, 'B was matched (call screen shown)');

    const aConnected = await waitForText(pageA, 'Connected', 30000);
    const bConnected = await waitForText(pageB, 'Connected', 30000);
    assert(aConnected, 'A reports Connected');
    assert(bConnected, 'B reports Connected');

    // ── 3. Media actually flowing ────────────────────────────────────────────
    // Decoding the first frame can trail the "Connected" pill by a moment.
    let vA = [];
    let vB = [];
    for (let i = 0; i < 8; i++) {
      vA = await videoState(pageA);
      vB = await videoState(pageB);
      const gotA = vA.some((v) => v.src && v.w > 0 && !v.muted);
      const gotB = vB.some((v) => v.src && v.w > 0 && !v.muted);
      if (gotA && gotB) break;
      await sleep(1000);
    }
    const remoteA = vA.find((v) => v.src && v.w > 0 && !v.muted);
    const remoteB = vB.find((v) => v.src && v.w > 0 && !v.muted);
    assert(Boolean(remoteA), `A receives remote video frames ${JSON.stringify(vA)}`);
    assert(Boolean(remoteB), `B receives remote video frames ${JSON.stringify(vB)}`);

    // Path readout (Local network / Direct P2P vs TURN relay) from getStats()
    let pathA = null;
    for (let i = 0; i < 8; i++) {
      pathA = await pageA.evaluate(
        () => (document.body.innerText.match(/Local network|Direct P2P|TURN relay/) || [])[0] || null,
      );
      if (pathA) break;
      await sleep(1000);
    }
    assert(Boolean(pathA), `network path readout shown (${pathA})`);
    if (FORCE_RELAY) {
      assert(pathA === 'TURN relay', `media is carried by the TURN relay (${pathA})`);
    }

    // ── 4. Controls: mute mic ────────────────────────────────────────────────
    await pageA.$$eval('footer button', (btns) => {
      const mic = btns.find((b) => (b.getAttribute('aria-label') || '').includes('microphone'));
      if (!mic) throw new Error('mic button missing');
      mic.click();
    });
    const micState = await pageA.evaluate(() => {
      const mic = [...document.querySelectorAll('footer button')].find((b) =>
        (b.getAttribute('aria-label') || '').toLowerCase().includes('microphone'),
      );
      return { pressed: mic.getAttribute('aria-pressed'), label: mic.getAttribute('aria-label') };
    });
    assert(micState.pressed === 'false' && micState.label.includes('Unmute'), 'A mic toggles off');

    // ── 5. Controls: stop camera ─────────────────────────────────────────────
    await pageA.$$eval('footer button', (btns) => {
      const cam = btns.find((b) => (b.getAttribute('aria-label') || '').toLowerCase().includes('camera'));
      cam.click();
    });
    const camState = await pageA.evaluate(() => {
      const cam = [...document.querySelectorAll('footer button')].find((b) =>
        (b.getAttribute('aria-label') || '').toLowerCase().includes('camera'),
      );
      const camBox = [...document.querySelectorAll('main div')].some((d) => d.textContent.trim() === 'CAM');
      return { pressed: cam.getAttribute('aria-pressed'), label: cam.getAttribute('aria-label'), camBox };
    });
    assert(camState.pressed === 'false' && camState.camBox, `A camera stops (${JSON.stringify(camState)})`);

    // ── 5b. Playground: chat round-trips between the partners ───────────────
    const openChat = (page) =>
      page.$$eval('footer button', (btns) => {
        const chat = btns.find((b) =>
          (b.getAttribute('aria-label') || '').toLowerCase().includes('chat'),
        );
        if (!chat) throw new Error('chat button missing');
        chat.click();
      });
    await openChat(pageA);
    await openChat(pageB);
    await pageA.waitForSelector('[aria-label="Message"]', { timeout: 8000 });
    await pageB.waitForSelector('[aria-label="Message"]', { timeout: 8000 });
    await pageA.type('[aria-label="Message"]', 'hello from A');
    await pageA.keyboard.press('Enter');
    const chatGotB = await waitForText(pageB, 'hello from A', 8000);
    const chatEchoA = await waitForText(pageA, 'hello from A', 3000);
    assert(chatGotB && chatEchoA, 'chat message reaches the partner (and echoes back)');

    // ── 5c. Playground: a spark card appears on BOTH screens ────────────────
    await pageA.$$eval('footer button', (btns) => {
      const spark = btns.find((b) =>
        (b.getAttribute('aria-label') || '').toLowerCase().includes('spark'),
      );
      if (!spark) throw new Error('spark button missing');
      spark.click();
    });
    const sparkA = await waitForText(pageA, 'SPARK', 6000);
    const sparkB = await waitForText(pageB, 'SPARK', 6000);
    assert(sparkA && sparkB, 'spark card shared to both screens');

    // ── 5d. Playground: rock-paper-scissors resolves identically ────────────
    await pageA.$$eval('footer button', (btns) => {
      const duel = btns.find((b) =>
        (b.getAttribute('aria-label') || '').toLowerCase().includes('duel'),
      );
      if (!duel) throw new Error('duel button missing');
      duel.click();
    });
    const duelA = await waitForText(pageA, 'to 2 wins', 6000);
    const duelB = await waitForText(pageB, 'to 2 wins', 6000);
    let duelPicks = true;
    try {
      await pageA.$$eval('button', (btns) => {
        const b = btns.find((x) => x.getAttribute('aria-label') === 'Pick rock');
        if (!b) throw new Error('Pick rock missing');
        b.click();
      });
      await pageB.$$eval('button', (btns) => {
        const b = btns.find((x) => x.getAttribute('aria-label') === 'Pick scissors');
        if (!b) throw new Error('Pick scissors missing');
        b.click();
      });
    } catch {
      duelPicks = false;
    }
    const beatsA = await waitForText(pageA, 'beats', 6000);
    const beatsB = await waitForText(pageB, 'beats', 6000);
    assert(
      duelA && duelB && duelPicks && beatsA && beatsB,
      `duel resolves the same round on both screens (A:${duelA}${beatsA} B:${duelB}${beatsB} picks:${duelPicks})`,
    );

    // ── 6. End call → partner told, BOTH land on the post-call screen ───────
    // Nothing re-queues itself any more: the user picks Next or Stop matching.
    // Record every rendered text state with a MutationObserver so the screens
    // that flash past can still be asserted afterwards.
    const observe = () => {
      window.__seen = [];
      window.__last = '';
      const mo = new MutationObserver(() => {
        const t = document.body.innerText.replace(/\n+/g, ' | ');
        if (t !== window.__last) {
          window.__last = t;
          window.__seen.push(t.slice(0, 400));
        }
      });
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
      return 'observing';
    };
    await pageA.evaluate(observe);
    await pageB.evaluate(observe);

    await pageA.$$eval('footer button', (btns) => {
      const end = btns.find((b) => (b.getAttribute('aria-label') || '') === 'End call');
      end.click();
    });
    await sleep(3000);

    const seenA = await pageA.evaluate(() => window.__seen);
    const seenB = await pageB.evaluate(() => window.__seen);
    assert(
      seenB.some((t) => t.includes('Stranger disconnected')),
      `B shows "Stranger disconnected" (${JSON.stringify(seenB.slice(0, 4))})`,
    );
    assert(
      seenA.some((t) => t.includes('Call ended')),
      `A lands on the post-call screen (${JSON.stringify(seenA.slice(0, 4))})`,
    );

    const aPost = await waitForText(pageA, 'Stop matching', 8000);
    const bPost = await waitForText(pageB, 'Stop matching', 8000);
    assert(aPost && bPost, 'both sides stop on the Next / Stop matching screen');

    // ── 6a. The Passport: the connected call stamped the partner's country ───
    // (A talked to DE — a brand-new passport entry, hence the celebration.)
    const stampBanner = await waitForText(pageA, 'NEW STAMP', 8000);
    const stampLine = await waitForText(pageA, 'countr(y|ies) in your passport', 8000);
    assert(
      stampBanner && stampLine,
      'post-call screen celebrates the new passport stamp (flag + count)',
    );
    const stillPost = await waitForText(pageA, 'Call ended', 4000);
    assert(stillPost, 'A is NOT requeued automatically after hanging up');

    // ── 6b. Share this connection → the post-call card ───────────────────────
    // Only offered because the call really connected, and it puts countries +
    // duration on a card — never a name. The status line tells us which rung
    // of the fallback ladder (share sheet → clipboard → visible text) was hit.
    const shareBtnOn = (page) =>
      page.evaluate(() =>
        [...document.querySelectorAll('button')].some((b) =>
          b.textContent.includes('Share this connection'),
        ),
      );
    const shareA = await shareBtnOn(pageA);
    const shareB = await shareBtnOn(pageB);
    assert(shareA && shareB, 'both post-call screens offer "Share this connection"');

    await clickButton(pageA, 'Share this connection');
    const cardReady = await waitForText(pageA, 'Connection card ready', 15000);
    assert(cardReady, 'sharing the card resolves to a ready status line');
    // Desktop has no share sheet: the rendered card itself must come back and
    // stay on screen (object URL from the same in-memory canvas).
    const cardShown = await pageA.evaluate(() =>
      Boolean(document.querySelector('img[src^="blob:"]')),
    );
    assert(cardShown, 'the rendered connection card is shown back on screen');
    await pageA.screenshot({ path: path.join(__dirname, 'e2e-share-card.png'), fullPage: true });

    // ── 7. Next → waiting screen → re-match ─────────────────────────────────
    // A goes first so its waiting screen is observable before B joins it.
    await clickButton(pageA, 'Next', true);
    const aWaitingAgain = await waitForText(pageA, 'Looking for someone', 15000);
    assert(aWaitingAgain, 'A reaches the waiting screen after Next');

    // ── 7b. The Passport tease — queue time that isn't idle ──────────────────
    // While A waits, the screen polls /api/presence and surfaces countries
    // online right now that A hasn't stamped yet (A holds DE, sits in KE).
    // NB: the strip's heading renders CSS-uppercased — match it as displayed.
    const tease = await waitForText(pageA, 'COLLECT WHILE YOU WAIT', 8000);
    assert(tease, 'waiting screen surfaces countries to collect while you queue');

    await clickButton(pageB, 'Next', true);
    const aAgain = await waitForText(pageA, 'End call', 25000);
    const bAgain = await waitForText(pageB, 'End call', 25000);
    assert(aAgain && bAgain, 'both sides are matched again after Next');

    // The stats HUD must come back on the new peer connection too.
    let pathA2 = null;
    let pathB2 = null;
    for (let i = 0; i < 10; i++) {
      const readPath = (page) =>
        page.evaluate(
          () => (document.body.innerText.match(/Local network|Direct P2P|TURN relay/) || [])[0] || null,
        );
      pathA2 = await readPath(pageA);
      pathB2 = await readPath(pageB);
      if (pathA2 && pathB2) break;
      await sleep(1000);
    }
    assert(Boolean(pathA2), `path HUD restored for A after re-match (${pathA2})`);
    assert(Boolean(pathB2), `path HUD restored for B after re-match (${pathB2})`);

    // ── 8. Telemetry: the server saw these calls and their media path ───────
    // `call:report` is emitted as soon as the selected candidate pair is known.
    await sleep(1500);
    const serverStats = await fetch(`${API}/api/stats`).then((r) => r.json()).catch(() => null);
    if (serverStats) {
      assert(
        (serverStats.calls?.outcomes?.connected ?? 0) >= 1,
        `telemetry recorded connected calls (${JSON.stringify(serverStats.calls?.outcomes)})`,
      );
      assert(
        (serverStats.calls?.paths?.unknown ?? 0) +
          (serverStats.calls?.paths?.relay ?? 0) +
          (serverStats.calls?.paths?.srflx ?? 0) +
          (serverStats.calls?.paths?.host ?? 0) >=
          1,
        `telemetry recorded media paths (${JSON.stringify(serverStats.calls?.paths)})`,
      );
      const sources = Object.entries(serverStats.calls?.iceSources || {})
        .filter(([, n]) => n > 0)
        .map(([k]) => k);
      assert(sources.length >= 1, `telemetry recorded the ICE source (${sources.join(', ')})`);
      if (FORCE_RELAY) {
        // Only meaningful in relay mode: without TURN configured this is false.
        assert(
          serverStats.ice?.turnConfigured === true,
          `server reports TURN configured (${JSON.stringify(serverStats.ice?.turnHosts)})`,
        );
        assert(
          (serverStats.calls?.paths?.relay ?? 0) >= 1,
          `telemetry attributed media to the relay (${JSON.stringify(serverStats.calls?.paths)})`,
        );
      }
    } else {
      bad('could not read /api/stats');
    }

    // ── 8b. Public presence board: GET /api/presence ─────────────────────────
    // Aggregate-only: country codes + sums, never a name, IP or session. Both
    // test pages carry a profile (KE and DE) while they sit in this call.
    const presence = await fetch(`${API}/api/presence`)
      .then((r) => r.json())
      .catch(() => null);
    const presenceCodes = (presence?.byCountry || []).map((r) => `${r.code}:${r.online}`).join(' ');
    assert(
      presence && typeof presence.online === 'number' && Array.isArray(presence.byCountry),
      `presence endpoint answers (${JSON.stringify(presence).slice(0, 140)})`,
    );
    assert(
      (presence?.byCountry || []).length >= 2,
      `counts are split per country (${presenceCodes})`,
    );
    assert(
      (presence?.byCountry || []).some((r) => r.code === 'DE') &&
        (presence?.byCountry || []).some((r) => r.code === 'KE'),
      `both test countries are on the board (${presenceCodes})`,
    );
    assert(
      (presence?.byCountry || []).every(
        (r) => /^[A-Z]{2}$/.test(r.code) && Number.isInteger(r.online) && r.online >= 1,
      ),
      'rows are aggregate code + count only',
    );

    // ── 9. Accounts: create → edit → reload keeps you signed in → sign out ──
    const ctxC = await browser.createBrowserContext();
    const pageC = await ctxC.newPage();
    pageC.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push('C: ' + m.text());
    });
    pageC.on('pageerror', (e) => consoleErrors.push('C pageerror: ' + e.message));

    const accName = `e2e_${Date.now().toString(36)}`;
    await pageC.goto(FORCE_RELAY ? `${APP}/?relay=1` : APP, { waitUntil: 'load', timeout: 20000 });
    await pageC.waitForSelector('#username', { timeout: 10000 });
    await pageC.type('#username', accName);
    await pageC.type('#password', 'e2e-password-123');

    await clickButton(pageC, 'Create account');
    const signedIn = await waitForText(pageC, 'Signed in as', 20000);
    assert(signedIn, `account created from the lobby ("${accName}")`);

    // Edit a profile field + preferences and persist them to the account.
    await pageC.select('#age', '31');
    await clickButton(pageC, 'Save profile');
    await waitForText(pageC, 'Profile saved', 10000);

    // Come back later: silent sign-in, everything prefilled.
    await pageC.reload({ waitUntil: 'load', timeout: 20000 });
    await pageC.waitForSelector('#username', { timeout: 10000 });
    const stillSignedIn = await waitForText(pageC, 'Signed in as', 20000);
    // The silent sign-in renders first, then the profile lands asynchronously —
    // over a remote DB that gap is real, so wait for the value itself.
    try {
      await pageC.waitForFunction(
        (name) => document.querySelector('#username')?.value === name,
        { timeout: 15000 },
        accName,
      );
    } catch { /* reported by the assert below */ }
    const prefill = await pageC.evaluate(() => ({
      username: document.querySelector('#username')?.value,
      age: document.querySelector('#age')?.value,
    }));
    assert(stillSignedIn, 'reload signs you back in automatically');
    assert(
      prefill.username === accName && prefill.age === '31',
      `profile prefilled from the account after reload (${JSON.stringify(prefill)})`,
    );

    await clickButton(pageC, 'Sign out');
    await sleep(2000);
    // NB: read innerText directly — `.label` text is CSS-uppercased, so a
    // case-sensitive pattern against it would never match.
    const afterSignOut = await pageC.evaluate(() => document.body.innerText);
    assert(
      !afterSignOut.includes('Signed in as') && afterSignOut.includes('Create account'),
      `sign out returns to the anonymous panel (${JSON.stringify(afterSignOut.slice(0, 120))})`,
    );
    await pageC.screenshot({ path: path.join(__dirname, 'e2e-account.png') });

    // ── 10. The board itself, from the lobby button ──────────────────────────
    await clickButton(pageC, "Who's online right now?");
    const boardOpen = await waitForText(pageC, 'Live across Europe', 10000);
    assert(boardOpen, 'lobby button opens the live board');
    // NB: `.label` headings render UPPERCASE (innerText reflects the CSS), and
    // the rows only appear once the first /api/presence response lands — so
    // wait for the heading as rendered, then for a real country row.
    const grouped = await waitForText(pageC, 'IN EUROPE', 10000);
    const hasRows = await waitForText(pageC, 'Germany', 10000);
    assert(grouped && hasRows, 'board groups the live counts and lists a country (DE is online)');
    await clickButton(pageC, 'Close', true);
    await sleep(400);
    const boardClosed = await pageC.evaluate(
      () => !document.body.innerText.includes('Live across Europe'),
    );
    assert(boardClosed, 'board closes again');

    // ── 11. The Passport book, from the lobby button ─────────────────────────
    await clickButton(pageC, 'My passport');
    const passportOpen = await waitForText(pageC, 'Your Passport', 8000);
    const passportGrid = await waitForText(pageC, 'countries stamped', 8000);
    assert(passportOpen && passportGrid, 'lobby button opens the passport book');
    await clickButton(pageC, 'Close', true);
    await sleep(300);

    await ctxC.close();

    const errors = consoleErrors.filter(
      (e) => !/favicon|ERR_ABORTED|Download the React DevTools/i.test(e),
    );
    assert(errors.length === 0, `no console errors (${JSON.stringify(errors.slice(0, 5))})`);

    await pageA.screenshot({ path: path.join(__dirname, 'e2e-call.png') });
    await browser.close();
  } catch (err) {
    bad('CRASH: ' + err.message);
    try { await browser.close(); } catch { /* ignore */ }
  }

  const failures = results.filter((r) => r.startsWith('FAIL'));
  console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
  if (spawnedServer) spawnedServer.kill();
  process.exit(failures.length ? 1 : 0);
}

main();
