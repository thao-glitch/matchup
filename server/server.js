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
const telemetry = require('./src/telemetry');
const store = require('./src/store');
const accounts = require('./src/accounts');
const passport = require('./src/passport');

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

// ── HTTP routes ──────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptimeSec: Math.round(process.uptime()),
    matchmaking: matchmaker ? matchmaker.stats() : null,
    store: typeof store.getMode === 'function' ? store.getMode() : 'memory',
    // Where accounts live: `maria` = the database on this PC, `memory` = dev.
    accounts: accounts.backend(),
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
    res.status(201).json(await accounts.register({ username, password, profile }));
  } catch (err) {
    sendAuthError(res, err);
  }
});

/** POST /api/auth/login { username, password } → 200 { token, user } */
app.post('/api/auth/login', credentialLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    res.json(await accounts.login({ username, password }));
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
  // Accounts follow the store: MariaDB when it is up, in-memory otherwise.
  accounts.init(store.getMode());
  passport.init(store.getMode());

  matchmaker = new Matchmaker(io, store);
  matchmaker.startTicker(Number(process.env.PRESENCE_INTERVAL_MS) || 5000);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });

  console.info(`[http] listening on http://${HOST}:${PORT} (${servesClient ? 'api + spa' : 'api'})`);
  console.info(`[http] CORS origin(s): ${ORIGINS.join(', ')}`);
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
