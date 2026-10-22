/* eslint-disable no-console */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const http = require('http');

const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const { getIceConfig, describeIce, isLocalIp } = require('./src/iceConfig');
const { Matchmaker } = require('./src/matchmaker');
const { RoomHub } = require('./src/rooms');
const telemetry = require('./src/telemetry');
const store = require('./src/store');
const accounts = require('./src/accounts');
const passport = require('./src/passport');
const settings = require('./src/settings');
const admin = require('./src/admin');
const payments = require('./src/payments');
const commerce = require('./src/commerce');
const mpesa = require('./src/mpesa');
const socialStore = require('./src/socialStore');

const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || '0.0.0.0';

/**
 * Allowed browser origins (comma separated).
 * Vercel gives you `https://your-app.vercel.app` (+ its preview URLs).
 */
const ORIGINS = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:4173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/** Optional: serve the built SPA from this same process (single-service deploys). */
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');
const servesClient = fs.existsSync(path.join(CLIENT_DIST, 'index.html'));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render / Railway / Cloudflare sit in front of us

app.use(cors({ origin: ORIGINS.includes('*') ? true : ORIGINS }));
app.use(express.json({ limit: '32kb' }));

// Minimal security headers (swap in `helmet` if you want the full set).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: ORIGINS.includes('*') ? true : ORIGINS, methods: ['GET', 'POST'] },
  // WebSocket first (lowest signaling latency), polling as the fallback for
  // networks that block WS upgrade.
  transports: ['websocket', 'polling'],
  pingInterval: 10_000,
  pingTimeout: 20_000,
  // SDP/ICE blobs are a few KB; anything near 1 MB is abuse.
  maxHttpBufferSize: 1e6,
  serveClient: false,
  // Sticky sessions are required if you ever add a second instance — see the
  // "Scaling" section of the README (Redis adapter + `@socket.io/sticky`).
});

/** @type {Matchmaker | null} */
let matchmaker = null;
/** @type {RoomHub | null} — group calls + conferences (attached per socket). */
let roomHub = null;

// ── HTTP routes ──────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptimeSec: Math.round(process.uptime()),
    matchmaking: matchmaker ? matchmaker.stats() : null,
    store: typeof store.getMode === 'function' ? store.getMode() : 'memory',
    // Where accounts live: `maria` = the database on this PC, `memory` = dev.
    accounts: accounts.backend(),
    // Dashboard + ledger: `maria` = live, `memory` = no database to hold them.
    admin: admin.backend(),
    payments: payments.backend(),
    // Which switch positions the lobby is currently rendering.
    features: settings.get().features,
    // Group calls / conferences that are live right now.
    rooms: roomHub ? roomHub.stats() : { rooms: 0, participants: 0 },
    // Operational glance: `turnConfigured: false` means strict-NAT users fail.
    ice: describeIce(),
  });
});

/**
 * Returns STUN + (when configured) short-lived TURN credentials.
 * The client never embeds secrets — it asks this endpoint at call time.
 */
app.get('/api/ice', async (req, res) => {
  try {
    // `req.ip` reflects X-Forwarded-For (trust proxy is set) — the tunnel
    // passes the browser's real address through, so a remote user never sees
    // the private LAN relay endpoints.
    const config = await getIceConfig({ local: isLocalIp(req.ip) });
    res.set('Cache-Control', 'no-store').json(config);
  } catch (err) {
    console.error('[ice] endpoint failed:', err.message);
    // Degrade rather than 500: the client falls back to its own STUN list.
    res.set('Cache-Control', 'no-store').json({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      expiresAt: Date.now() + 5 * 60 * 1000,
      source: 'emergency-fallback',
    });
  }
});

app.get('/api/stats', async (req, res) => {
  const [db, matchmaking] = await Promise.all([store.stats(), Promise.resolve(matchmaker?.stats())]);
  // `calls` answers "is TURN earning its keep?" — success rate, relay share,
  // and how much traffic is still running without a relay fallback.
  res.json({ ...db, matchmaking, ice: describeIce(), calls: telemetry.snapshot() });
});

/**
 * GET /api/config → what the lobby needs to render itself: feature switches
 * plus the paybill block (bank, number, price, wording). Public on purpose —
 * it is the same information the payment screen shows to everyone — and it
 * never leaves this process (read from the settings cache, no DB round-trip).
 */
app.get('/api/config', (req, res) => {
  res.set('Cache-Control', 'no-cache').json(settings.publicConfig());
});

// ── Accounts (username + password) ──────────────────────────────────────────

/**
 * Fixed-window per-IP limiter. Registration and login are the only endpoints
 * an attacker can use to burn CPU (scrypt) or guess passwords, so they get a
 * tight budget; the authenticated routes get a generous one.
 */
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 5000) {
      for (const [key, entry] of hits) {
        if (now - entry.start > windowMs) hits.delete(key);
      }
    }
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    let entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      entry = { start: now, count: 0 };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({
        error: { code: 'rate-limit', message: 'Too many attempts — wait a minute and try again.' },
      });
    }
    return next();
  };
}

const credentialLimiter = rateLimit({ windowMs: 60_000, max: 20 });
const sessionLimiter = rateLimit({ windowMs: 60_000, max: 120 });
// The Europe board polls every ~10s while it is open — 60/min/IP is generous.
const presenceLimiter = rateLimit({ windowMs: 60_000, max: 60 });

/**
 * GET /api/presence → { online, looking, located, byCountry: [{code, online}] }
 *
 * The live per-country counts behind the "#europe" board. Aggregated in
 * memory from the profiles sockets submitted on `queue:join` — only sums ever
 * leave this process, so nothing individual (name, IP, session) can leak.
 */
app.get('/api/presence', presenceLimiter, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(
    matchmaker
      ? matchmaker.geoPresence()
      : { online: 0, looking: 0, located: 0, byCountry: [] },
  );
});

const bearerOf = (req) => {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
};

function sendAuthError(res, err) {
  if (err instanceof accounts.AuthError) {
    return res
      .status(err.status)
      .json({ error: { code: err.code, message: err.message } });
  }
  console.error('[auth] unexpected error:', err);
  return res
    .status(500)
    .json({ error: { code: 'internal', message: 'Something went wrong — please try again.' } });
}

/** POST /api/auth/register { username, password, profile } → 201 { token, user } */
app.post('/api/auth/register', credentialLimiter, async (req, res) => {
  try {
    const { username, password, profile } = req.body || {};
    res.status(201).json(await accounts.register({ username, password, profile, ip: req.ip }));
  } catch (err) {
    sendAuthError(res, err);
  }
});

/** POST /api/auth/login { username, password } → 200 { token, user } */
app.post('/api/auth/login', credentialLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    res.json(await accounts.login({ username, password, ip: req.ip }));
  } catch (err) {
    sendAuthError(res, err);
  }
});

/** GET /api/auth/me (Bearer) → 200 { user } — the client's silent re-login. */
app.get('/api/auth/me', sessionLimiter, async (req, res) => {
  try {
    const user = await accounts.authenticate(bearerOf(req));
    if (!user) {
      return res
        .status(401)
        .json({ error: { code: 'unauthorized', message: 'Please sign in again.' } });
    }
    return res.json({ user });
  } catch (err) {
    return sendAuthError(res, err);
  }
});

/** PUT /api/auth/profile (Bearer) { profile } → 200 { user } — freely editable. */
app.put('/api/auth/profile', sessionLimiter, async (req, res) => {
  try {
    res.json(await accounts.saveProfile(bearerOf(req), (req.body || {}).profile ?? req.body));
  } catch (err) {
    sendAuthError(res, err);
  }
});

/** POST /api/auth/logout (Bearer) → 204. Always succeeds. */
app.post('/api/auth/logout', sessionLimiter, async (req, res) => {
  await accounts.logout(bearerOf(req));
  res.status(204).end();
});

/**
 * POST /api/passport/sync (Bearer) { stamps: { "DE": 3, … } } → 200
 *   { stamps, unique, total, streak, lastDay }
 *
 * The Passport's server half: merge the device's country counts with the
 * stored ones (per-country max) and hand back the union. Anonymous visitors
 * have no token and stay on localStorage — the endpoint only exists so a
 * signed-in collection survives a new phone.
 */
app.post('/api/passport/sync', sessionLimiter, async (req, res) => {
  try {
    const user = await accounts.authenticate(bearerOf(req));
    if (!user || typeof user.id !== 'number') {
      return res
        .status(401)
        .json({ error: { code: 'unauthorized', message: 'Please sign in again.' } });
    }
    return res.json(await passport.sync(user.id, (req.body || {}).stamps));
  } catch (err) {
    if (err instanceof accounts.AuthError) return sendAuthError(res, err);
    console.error('[passport] sync failed:', err.message);
    return res.status(500).json({
      error: {
        code: 'storage',
        message: 'Your passport could not sync — it stays saved on this device.',
      },
    });
  }
});

// ── Paybill payments ─────────────────────────────────────────────────────────

/** Creating an intent is rare (once per person); 30/min/IP is already generous. */
const paymentLimiter = rateLimit({ windowMs: 60_000, max: 30 });

/** POST /api/payments/intent (Bearer) { providerRef? } → 201 { payment } */
app.post('/api/payments/intent', paymentLimiter, async (req, res) => {
  try {
    const user = await accounts.authenticate(bearerOf(req));
    if (!user) {
      return res
        .status(401)
        .json({ error: { code: 'unauthorized', message: 'Please sign in to get a reference.' } });
    }
    res.status(201).json({ payment: await payments.createIntent(user, req.body || {}) });
  } catch (err) {
    sendAuthError(res, err);
  }
});

/** GET /api/payments/mine (Bearer) → { payments, premiumUntil } — own rows only. */
app.get('/api/payments/mine', sessionLimiter, async (req, res) => {
  try {
    const user = await accounts.authenticate(bearerOf(req));
    res.set('Cache-Control', 'no-store').json(await payments.mine(user));
  } catch (err) {
    sendAuthError(res, err);
  }
});

// ── Social platform: posts, charges, wallet, rooms ──────────────────────────

/**
 * Reading the feed is the most-hit surface in the app — it gets its own,
 * generous bucket so scrolling can never be throttled by someone else's
 * page refreshes on the same IP.
 */
const readLimiter = rateLimit({ windowMs: 60_000, max: 240 });
/** Publishing, commenting, uploading, paying: 30/min/IP is a real human. */
const contentLimiter = rateLimit({ windowMs: 60_000, max: 30 });

/** Bearer → account, or `null` (the feed is readable signed out). */
const optionalUser = (req) => accounts.authenticate(bearerOf(req));

/** Bearer → account, or a 401 through the usual envelope. */
async function requireUser(req, res) {
  const user = await accounts.authenticate(bearerOf(req));
  if (!user) {
    res
      .status(401)
      .json({ error: { code: 'unauthorized', message: 'Please sign in to continue.' } });
    return null;
  }
  return user;
}

const intQuery = (value, fallback) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// ── Posts ────────────────────────────────────────────────────────────────────

/** GET /api/posts?page=&size=&q=&adult= → one page of the feed. */
app.get('/api/posts', readLimiter, async (req, res) => {
  try {
    const user = await optionalUser(req);
    const { page, size, q, adult } = req.query || {};
    res.set('Cache-Control', 'no-store').json(
      await commerce.feed(user, {
        page: intQuery(page, 1),
        size: intQuery(size, 20),
        q: typeof q === 'string' ? q.slice(0, 80) : '',
        adult: adult === '1' || adult === 'true',
      }),
    );
  } catch (err) {
    sendAuthError(res, err);
  }
});

/** GET /api/posts/mine (Bearer) → the creator's own rows, hidden ones included. */
app.get('/api/posts/mine', readLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return undefined;
    const { page, size } = req.query || {};
    res.set('Cache-Control', 'no-store').json(
      await commerce.mine(user, { page: intQuery(page, 1), size: intQuery(size, 20) }),
    );
  } catch (err) {
    sendAuthError(res, err);
  }
  return undefined;
});

/** GET /api/posts/:id → one post as the viewer may see it (counts a view). */
app.get('/api/posts/:id', readLimiter, async (req, res) => {
  try {
    const user = await optionalUser(req);
    res.set('Cache-Control', 'no-store').json(await commerce.postDetail(user, Number(req.params.id)));
  } catch (err) {
    sendAuthError(res, err);
  }
});

/**
 * GET /api/posts/:id/media → the file behind a post.
 * This route IS the paywall: uploads are not served statically, so a viewer
 * without a paid charge gets 402 here and nowhere else to try.
 */
app.get('/api/posts/:id/media', readLimiter, async (req, res) => {
  try {
    const user = await optionalUser(req);
    await commerce.readPostMedia(user, Number(req.params.id), res);
  } catch (err) {
    sendAuthError(res, err);
  }
});

/** POST /api/posts (Bearer) { caption, price, isAdult, type, mediaKey?, linkUrl? } */
app.post('/api/posts', contentLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return undefined;
    res.status(201).json({ post: await commerce.createPost(user, req.body || {}) });
  } catch (err) {
    sendAuthError(res, err);
  }
  return undefined;
});

/** DELETE /api/posts/:id (Bearer) → 204 — the creator's own post only. */
app.delete('/api/posts/:id', contentLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return undefined;
    await commerce.removePost(user, Number(req.params.id));
    res.status(204).end();
  } catch (err) {
    sendAuthError(res, err);
  }
  return undefined;
});

/** POST /api/posts/:id/like (Bearer) { liked } → { liked, likes } */
app.post('/api/posts/:id/like', contentLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return undefined;
    res.json(await commerce.like(user, Number(req.params.id), (req.body || {}).liked));
  } catch (err) {
    sendAuthError(res, err);
  }
  return undefined;
});

/** GET /api/posts/:id/comments → { items } */
app.get('/api/posts/:id/comments', readLimiter, async (req, res) => {
  try {
    const user = await optionalUser(req);
    res.set('Cache-Control', 'no-store').json(await commerce.listComments(user, Number(req.params.id)));
  } catch (err) {
    sendAuthError(res, err);
  }
});

/** POST /api/posts/:id/comments (Bearer) { body } → 201 { comment } */
app.post('/api/posts/:id/comments', contentLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return undefined;
    res.status(201).json(await commerce.addComment(user, Number(req.params.id), (req.body || {}).body));
  } catch (err) {
    sendAuthError(res, err);
  }
  return undefined;
});

/**
 * POST /api/media (Bearer) raw bytes → 201 { key }.
 * `express.raw` with a real body limit — this is the one route where the
 * payload is not JSON, so the global 32 kb JSON parser never sees it.
 */
app.post(
  '/api/media',
  contentLimiter,
  express.raw({ type: () => true, limit: '32mb' }),
  async (req, res) => {
    try {
      const user = await requireUser(req, res);
      if (!user) return undefined;
      const key = await commerce.saveUpload({
        buffer: req.body,
        contentType: req.headers['content-type'],
      });
      res.status(201).json({ key });
    } catch (err) {
      sendAuthError(res, err);
    }
    return undefined;
  },
);

// ── Charges (M-PESA STK push) ────────────────────────────────────────────────

/**
 * POST /api/charges (Bearer) { purpose, refId, phone } → 201 { charge }
 * Opens the row, fires the STK push, and the phone prompts for the PIN.
 */
app.post('/api/charges', contentLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return undefined;
    res.status(201).json(await commerce.createCharge(user, req.body || {}));
  } catch (err) {
    sendAuthError(res, err);
  }
  return undefined;
});

/** GET /api/charges/:id (Bearer) → poll until pending becomes paid/failed. */
app.get('/api/charges/:id', readLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return undefined;
    res.set('Cache-Control', 'no-store').json(await commerce.chargeStatus(user, Number(req.params.id)));
  } catch (err) {
    sendAuthError(res, err);
  }
  return undefined;
});

/**
 * POST /api/mpesa/callback — Daraja's result notification.
 *
 * Public on purpose (Safaricom cannot send a bearer token), so it validates
 * by `CheckoutRequestID` alone: an unknown id is ACKed rather than retried
 * forever, and settlement itself is idempotent (the `pending → paid` UPDATE
 * decides who credits the wallet — this endpoint, a status poll, or the
 * owner approving manually — exactly once).
 */
app.post('/api/mpesa/callback', express.json({ limit: '64kb' }), async (req, res) => {
  const parsed = mpesa.parseCallback(req.body);
  if (!parsed) return res.status(200).json(mpesa.NACK);
  try {
    const charge = await socialStore.getChargeByCheckout(parsed.checkoutRequestId);
    if (!charge) {
      console.warn(`[mpesa] callback for unknown checkout ${parsed.checkoutRequestId}`);
      return res.status(200).json(mpesa.ACK);
    }
    if (parsed.resultCode === 0) {
      const settled = await commerce.settle(charge.id, {
        receipt: parsed.receipt,
        resultCode: 0,
        description: parsed.description,
      });
      console.info(
        `[mpesa] ${settled ? 'settled' : 'already settled'} charge #${charge.id} ` +
          `KES ${charge.amount} ${parsed.receipt || ''} (${charge.purpose} ${charge.refId})`,
      );
    } else {
      await commerce.fail(charge.id, {
        resultCode: parsed.resultCode,
        description: parsed.description,
      });
      console.info(
        `[mpesa] charge #${charge.id} failed: ${parsed.resultCode} ${parsed.description}`,
      );
    }
    return res.status(200).json(mpesa.ACK);
  } catch (err) {
    console.error('[mpesa] callback failed:', err.message);
    // 200 anyway: Daraja retries on non-2xx, and a retried settle is safe.
    return res.status(200).json(mpesa.ACK);
  }
});

// ── Wallet + rooms (public read) ─────────────────────────────────────────────

/** GET /api/wallet (Bearer) → { wallet, entries } — the creator's money. */
app.get('/api/wallet', readLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return undefined;
    res.set('Cache-Control', 'no-store').json(await commerce.wallet(user));
  } catch (err) {
    sendAuthError(res, err);
  }
  return undefined;
});

/** POST /api/wallet/withdraw (Bearer) { phone, amount } → reserves the balance. */
app.post('/api/wallet/withdraw', contentLimiter, async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return undefined;
    res.status(201).json(await commerce.withdraw(user, req.body || {}));
  } catch (err) {
    sendAuthError(res, err);
  }
  return undefined;
});

/** GET /api/rooms?kind=&adult= → live group calls + conferences. */
app.get('/api/rooms', readLimiter, async (req, res) => {
  try {
    const user = await optionalUser(req);
    const { kind, adult } = req.query || {};
    const result = await commerce.rooms(user, {
      kind: typeof kind === 'string' ? kind : '',
      adult: adult === '1' || adult === 'true',
    });
    // Live head-count comes from the socket hub, not the database.
    res.set('Cache-Control', 'no-store').json({
      items: roomHub ? roomHub.withCounts(result.items) : result.items.map((r) => ({ ...r, participants: 0 })),
    });
  } catch (err) {
    sendAuthError(res, err);
  }
});

/** GET /api/rooms/:slug → one room plus this viewer's entry rights. */
app.get('/api/rooms/:slug', readLimiter, async (req, res) => {
  try {
    const user = await optionalUser(req);
    const data = await commerce.roomInfo(user, req.params.slug);
    res.set('Cache-Control', 'no-store').json({
      ...data,
      room: roomHub
        ? { ...data.room, participants: roomHub.liveCount(data.room.slug) }
        : { ...data.room, participants: 0 },
    });
  } catch (err) {
    sendAuthError(res, err);
  }
});

// ── Admin dashboard ──────────────────────────────────────────────────────────

/**
 * The dashboard gets its own, much tighter login budget: 10 attempts/min/IP is
 * plenty for a human and hopeless for a password guesser. Sessions and reads
 * share a generous bucket (the users table pages over the same endpoint).
 */
const adminLoginLimiter = rateLimit({ windowMs: 60_000, max: 10 });
const adminLimiter = rateLimit({ windowMs: 60_000, max: 300 });

/**
 * Wrap a dashboard handler with authentication: every route below runs only
 * with a valid admin session, and every failure (auth or thrown error) leaves
 * through the same `{ error: { code, message } }` envelope as the user API.
 */
function adminRoute(handler) {
  return async (req, res) => {
    try {
      const identity = await admin.authenticate(bearerOf(req));
      if (!identity) {
        return res
          .status(401)
          .json({ error: { code: 'unauthorized', message: 'Sign in to the dashboard.' } });
      }
      // A handler may either answer itself (`res.json(...)` → returns the
      // response) or hand back a plain payload, which is sent as JSON here.
      const out = await handler(identity, req, res);
      if (out === undefined || out === res || res.writableEnded) return undefined;
      return res.json(out);
    } catch (err) {
      return sendAuthError(res, err);
    }
  };
}

/** POST /api/admin/login { username, password } → { token, admin } */
app.post('/api/admin/login', adminLoginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    res.json(await admin.login({ username, password }));
  } catch (err) {
    sendAuthError(res, err);
  }
});

/** POST /api/admin/logout (Bearer) → 204. Always succeeds. */
app.post('/api/admin/logout', adminLimiter, async (req, res) => {
  await admin.logout(bearerOf(req));
  res.status(204).end();
});

/** GET /api/admin/me (Bearer) → { admin } — the dashboard's silent re-login. */
app.get('/api/admin/me', adminLimiter, adminRoute(async (identity) => ({ admin: identity })));

/** GET /api/admin/overview → accounts, live queue, calls, ledger, settings. */
app.get('/api/admin/overview', adminLimiter, adminRoute(async (identity, req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json(await admin.overview(matchmaker, roomHub));
}));

/** GET /api/admin/users?q=&filter=&page=&size= → { items, total, page, size } */
app.get('/api/admin/users', adminLimiter, adminRoute(async (identity, req, res) => {
  const { q, filter, page, size } = req.query || {};
  res.set('Cache-Control', 'no-store');
  const result = await admin.listUsers({ q, filter, page: Number(page), size: Number(size) });
  res.json({ ...result, page: Math.max(1, Number(page) || 1), size: Math.min(100, Number(size) || 25) });
}));

/** PATCH /api/admin/users/:id { banned?, premiumDays? } → { user } */
app.patch('/api/admin/users/:id', adminLimiter, adminRoute(async (identity, req, res) => {
  const user = await admin.updateUser(identity, Number(req.params.id), req.body || {});
  res.json({ user });
}));

/** DELETE /api/admin/users/:id → 204 (sessions + passport cascade away). */
app.delete('/api/admin/users/:id', adminLimiter, adminRoute(async (identity, req, res) => {
  await admin.deleteUser(identity, Number(req.params.id));
  res.status(204).end();
}));

/** GET /api/admin/payments?status=&page=&size= → { items, total, page, size } */
app.get('/api/admin/payments', adminLimiter, adminRoute(async (identity, req, res) => {
  const { status, page, size } = req.query || {};
  res.set('Cache-Control', 'no-store');
  const result = await admin.listPayments({ status, page: Number(page), size: Number(size) });
  res.json({ ...result, page: Math.max(1, Number(page) || 1), size: Math.min(100, Number(size) || 25) });
}));

/** PATCH /api/admin/payments/:id { status, note? } → { payment } — approval grants premium. */
app.patch('/api/admin/payments/:id', adminLimiter, adminRoute(async (identity, req, res) => {
  const payment = await admin.reviewPayment(identity, Number(req.params.id), req.body || {});
  res.json({ payment });
}));

/** GET /api/admin/settings → the full payment + feature configuration. */
app.get('/api/admin/settings', adminLimiter, adminRoute(async () => ({
  settings: await admin.getSettings(),
})));

/** PUT /api/admin/settings { payment?, features? } → { settings } (validated). */
app.put('/api/admin/settings', adminLimiter, adminRoute(async (identity, req, res) => {
  res.json({ settings: await admin.saveSettings(identity, req.body || {}) });
}));

/** GET /api/admin/audit?limit= → newest dashboard actions first. */
app.get('/api/admin/audit', adminLimiter, adminRoute(async (identity, req, res) => {
  res.json({ items: await admin.listAudit(Number((req.query || {}).limit) || 100) });
}));

// ── Social platform dashboard ────────────────────────────────────────────────

/** GET /api/admin/posts?status=&q=&page=&size= → the moderation queue. */
app.get('/api/admin/posts', adminLimiter, adminRoute(async (identity, req, res) => {
  const { status, q, page, size, creatorId } = req.query || {};
  res.set('Cache-Control', 'no-store');
  const result = await admin.listPosts({
    status: typeof status === 'string' ? status : 'all',
    q: typeof q === 'string' ? q.slice(0, 80) : '',
    creatorId: creatorId ? Number(creatorId) : null,
    page: Number(page),
    size: Number(size),
  });
  res.json({ ...result, page: Math.max(1, Number(page) || 1), size: Math.min(100, Number(size) || 25) });
}));

/** PATCH /api/admin/posts/:id { status?, note?, deleteComments? } → { post } */
app.patch('/api/admin/posts/:id', adminLimiter, adminRoute(async (identity, req, res) => {
  res.json(await admin.moderatePost(identity, Number(req.params.id), req.body || {}));
}));

/** GET /api/admin/charges?status=&purpose=&q=&page=&size= → the new ledger. */
app.get('/api/admin/charges', adminLimiter, adminRoute(async (identity, req, res) => {
  const { status, purpose, q, page, size } = req.query || {};
  res.set('Cache-Control', 'no-store');
  const result = await admin.listCharges({
    status: typeof status === 'string' ? status : '',
    purpose: typeof purpose === 'string' ? purpose : '',
    q: typeof q === 'string' ? q.slice(0, 80) : '',
    page: Number(page),
    size: Number(size),
  });
  res.json({ ...result, page: Math.max(1, Number(page) || 1), size: Math.min(100, Number(size) || 25) });
}));

/** PATCH /api/admin/charges/:id { status: 'paid'|'failed', note? } → { charge } */
app.patch('/api/admin/charges/:id', adminLimiter, adminRoute(async (identity, req, res) => {
  res.json({ charge: await admin.reviewCharge(identity, Number(req.params.id), req.body || {}) });
}));

/** GET /api/admin/rooms?status=&page=&size= → every room, live head-counts in. */
app.get('/api/admin/rooms', adminLimiter, adminRoute(async (identity, req, res) => {
  const { status, kind, page, size } = req.query || {};
  res.set('Cache-Control', 'no-store');
  const result = await admin.listRooms({
    status: typeof status === 'string' ? status : 'live',
    kind: typeof kind === 'string' ? kind : '',
    page: Number(page),
    size: Number(size),
  });
  res.json({
    ...result,
    items: roomHub ? roomHub.withCounts(result.items) : result.items.map((r) => ({ ...r, participants: 0 })),
    page: Math.max(1, Number(page) || 1),
    size: Math.min(100, Number(size) || 25),
  });
}));

/** PATCH /api/admin/rooms/:id { status: 'live'|'ended' } → closes it live. */
app.patch('/api/admin/rooms/:id', adminLimiter, adminRoute(async (identity, req, res) => {
  res.json(await admin.updateRoom(identity, Number(req.params.id), req.body || {}, roomHub));
}));

/** GET /api/admin/earnings?days= → gross, the house cut, wallets, payouts. */
app.get('/api/admin/earnings', adminLimiter, adminRoute(async (identity, req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json(await admin.earnings({ days: Number((req.query || {}).days) || 30 }));
}));

/** GET /api/admin/wallets?page=&size=&q= → every creator balance. */
app.get('/api/admin/wallets', adminLimiter, adminRoute(async (identity, req, res) => {
  const { q, page, size } = req.query || {};
  res.set('Cache-Control', 'no-store');
  const result = await admin.listWallets({
    q: typeof q === 'string' ? q.slice(0, 80) : '',
    page: Number(page),
    size: Number(size),
  });
  res.json({ ...result, page: Math.max(1, Number(page) || 1), size: Math.min(100, Number(size) || 25) });
}));

/** POST /api/admin/wallets/adjust { accountId, amount, memo } → { wallet } */
app.post('/api/admin/wallets/adjust', adminLimiter, adminRoute(async (identity, req, res) => {
  const { accountId, amount, memo } = req.body || {};
  res.json(await admin.adjustWallet(identity, Number(accountId), Number(amount), memo));
}));

/** PATCH /api/admin/wallet-entries/:id { status } → approve/reject a payout. */
app.patch('/api/admin/wallet-entries/:id', adminLimiter, adminRoute(async (identity, req, res) => {
  res.json(await admin.settlePayout(identity, Number(req.params.id), req.body || {}));
}));

/** GET /api/admin/wallet-entries?status=&page=&size= → the transaction log. */
app.get('/api/admin/wallet-entries', adminLimiter, adminRoute(async (identity, req, res) => {
  const { status, page, size } = req.query || {};
  res.set('Cache-Control', 'no-store');
  const result = await socialStore.listWalletEntries({
    status: typeof status === 'string' ? status : '',
    page: Number(page),
    size: Number(size),
  });
  res.json({ ...result, page: Math.max(1, Number(page) || 1), size: Math.min(100, Number(size) || 25) });
}));

// ── Optional: host the SPA from this process ─────────────────────────────────
if (servesClient) {
  console.info(`[http] serving client bundle from ${CLIENT_DIST}`);
  app.use(express.static(CLIENT_DIST, { maxAge: '1h', index: 'index.html' }));
  // SPA fallback for any non-API GET (Express 5 dropped the `*` wildcard).
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

// ── Signaling ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  matchmaker?.attach(socket);
  // Group calls / conferences run alongside the matchmaker on the same
  // socket — a user can hold a room open and still queue for1v1.
  roomHub?.attach(socket);

  // Fresh sockets get an immediate presence snapshot so the lobby counter is
  // never `0` while the periodic broadcast is still pending.
  if (matchmaker) socket.emit('presence', matchmaker.presence());

  socket.on('error', (err) => {
    console.error(`[socket] ${socket.id} error:`, err.message);
  });
});

// ── Boot ─────────────────────────────────────────────────────────────────────

async function main() {
  await store.initStore();
  const mode = store.getMode();
  // Accounts follow the store: MariaDB when it is up, in-memory otherwise.
  accounts.init(mode);
  passport.init(mode);
  // Payments, settings and the dashboard all need a real database — they
  // degrade to clear 503s instead of pretending to work.
  payments.init(mode);
  admin.init(mode);
  // The social platform (posts, charges, wallets, rooms) follows the ledger:
  // it needs the same database and degrades to clear 503s without it.
  commerce.init(mode);

  await settings.load();
  await admin.bootstrap();
  await accounts.refreshBanIps();

  matchmaker = new Matchmaker(io, store);
  matchmaker.startTicker(Number(process.env.PRESENCE_INTERVAL_MS) || 5000);
  roomHub = new RoomHub(io);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });

  console.info(`[http] listening on http://${HOST}:${PORT} (${servesClient ? 'api + spa' : 'api'})`);
  console.info(`[http] CORS origin(s): ${ORIGINS.join(', ')}`);
  if (mode !== 'maria') {
    console.warn(
      '[admin] no database → /admin, payments and settings are disabled (MARIADB_* not configured)',
    );
  }
}

function shutdown(signal) {
  console.info(`[server] ${signal} received, shutting down…`);
  matchmaker?.stopTicker();
  io.close(() => {
    server.close(() => process.exit(0));
  });
  // Never hang a deploy: force-exit after 8s if sockets refuse to drain.
  setTimeout(() => process.exit(0), 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception:', err);
});

main().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
