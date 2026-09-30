/**
 * ICE server configuration — the single biggest lever for global reach.
 *
 * ┌─ How WebRTC gets two peers talking ───────────────────────────────────────┐
 * │ STUN  Discovers each side's public IP:port. Free, fast, and enough for     │
 * │       roughly 85-90% of residential NATs.                                 │
 * │ TURN  Relays the actual media when discovery fails: symmetric NAT, double │
 * │       NAT, CGNAT and strict corporate firewalls. Without TURN those users │
 * │       never connect at all — that is the classic "one in ten strangers     │
 * │       gets a black screen" problem.                                       │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Credentials are minted server-side and handed to the client through
 * `GET /api/ice`, so no long-lived secret is ever shipped in the JS bundle.
 */

const crypto = require('crypto');

const STUN_SERVERS = [
  {
    // Google's anycast STUN fleet: any region reaches a nearby node, which
    // keeps the ICE check round-trip low on every continent.
    urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun2.l.google.com:19302',
      'stun:stun3.l.google.com:19302',
      'stun:stun4.l.google.com:19302',
      'stun:global.stun.twilio.com:3478',
    ],
  },
];

/**
 * ==========================================================================
 *  TURN — REQUIRED FOR TRUE GLOBAL REACH
 * ==========================================================================
 * A TURN server is the only mechanism that can carry media past symmetric
 * NATs, CGNAT and firewalls that block UDP entirely (many corporate, hotel
 * and carrier networks do).
 *
 * Leave these unset and the app still works for most users (STUN-only P2P),
 * but strict-NAT users will fail with "Unable to connect". You can see your
 * real failure rate in `GET /api/stats` → `calls.outcomes`.
 *
 * Four ways to fill them in (README → "Deploying TURN"):
 *
 *  1) Cloudflare Realtime TURN (free tier, zero infrastructure):
 *       CF_TURN_KEY_ID=<turn key id>        CF_TURN_KEY_SECRET=<turn key secret>
 *     Short-lived credentials are minted per request from Cloudflare's API —
 *     no relay of your own to run, no router to configure. Keys come from the
 *     Cloudflare dashboard (Realtime → TURN), free plan included.
 *
 *  2) coturn + TURN REST API (~$5/mo VPS, no per-minute bill):
 *       TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tls
 *       TURN_SECRET=<same value as coturn's static-auth-secret>
 *     Credentials are minted per request with HMAC-SHA1 (see mintRestCreds),
 *     exactly the algorithm coturn's `use-auth-secret` expects. Nothing
 *     long-lived is ever handed to the browser, and no password sits in a
 *     config file.
 *
 *  3) Twilio Network Traversal (zero ops, usage-priced):
 *       TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *       TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *
 *  4) Any static TURN (Metered, a hand-managed coturn):
 *       TURN_URLS=turn:turn.example.com:3478?transport=udp
 *       TURN_USERNAME=matchup
 *       TURN_CREDENTIAL=super-secret
 *
 * Never hard-code a long-lived TURN password in the client bundle.
 * ==========================================================================
 */

/**
 * Mint a time-limited credential for the TURN REST API (coturn
 * `--use-auth-secret`, and every provider that speaks the same draft):
 *
 *   username   = <unix seconds *of expiry*> ":" <random id>
 *   credential = base64( HMAC-SHA1( key = TURN_SECRET, message = username ) )
 *
 * The timestamp is the **expiry**, not the issue time — servers validate it
 * as "not in the past", so minting with `Date.now()` yields a credential that
 * is rejected immediately (coturn logs "credentials … have expired").
 *
 * The server and coturn share only the secret; the browser sees a credential
 * that expires, so a leaked value is worthless after the TTL.
 */
function mintRestCreds(secret, ttlSeconds) {
  const ttl = Math.max(60, ttlSeconds);
  const expiresAtSec = Math.floor(Date.now() / 1000) + ttl;
  const username = `${expiresAtSec}:${crypto.randomBytes(6).toString('hex')}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  // Refresh a minute before the credential actually expires (clients cache
  // until `expiresAt - 30s`), but never inside the TTL itself.
  const marginSec = Math.min(60, Math.floor(ttl / 3));
  return {
    username,
    credential,
    expiresAt: (expiresAtSec - marginSec) * 1000,
  };
}

/** `turn:host:port` / `turns:host:port` → host, for the ops readout only. */
function turnHosts(servers) {
  const hosts = new Set();
  for (const server of servers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const url of urls) {
      if (!String(url).startsWith('turn')) continue;
      const m = String(url).match(/^turns?:\[?([^\]]+?)\]?:(\d+)/);
      if (m) hosts.add(`${m[1]}:${m[2]}`);
    }
  }
  return [...hosts];
}

let cached = null; // { iceServers, expiresAt, source }
let inflight = null;
let warned = false;

function warnOnce(message) {
  if (warned) return;
  warned = true;
  console.warn(`[ice] ${message}`);
}

function normalizeServer(server) {
  if (!server) return null;
  // Twilio's legacy payload uses singular "url"; the WebRTC spec uses "urls".
  const urls = server.urls || server.url;
  if (!urls) return null;

  const out = { urls };
  if (server.username) out.username = server.username;
  if (server.credential) out.credential = server.credential;
  return out;
}

function hasTurn(servers) {
  return servers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((u) => String(u).startsWith('turn'));
  });
}

/** Mint (and cache) short-lived Twilio TURN credentials. */
async function fetchTwilioIceServers() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Tokens.json`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Twilio token endpoint returned ${res.status}`);

  const data = await res.json();
  const iceServers = (data.ice_servers || [])
    .map(normalizeServer)
    .filter(Boolean);
  if (iceServers.length === 0) throw new Error('Twilio returned no ICE servers');

  // Refresh a minute before the credential actually expires.
  const ttlSeconds = Number(data.ttl) || 3600;
  return {
    iceServers,
    expiresAt: Date.now() + Math.max(60, ttlSeconds - 60) * 1000,
    source: 'twilio',
  };
}

/**
 * Cloudflare Realtime TURN — a free-tier relay with no infrastructure to run.
 *
 *   CF_TURN_KEY_ID + CF_TURN_KEY_SECRET   (dashboard → Realtime → TURN keys)
 *
 * Cloudflare issues short-lived credentials per request (TTL ≤ 48h), so the
 * key secret never reaches the browser and there is no router, VPS or coturn
 * to keep alive — the last mile of "the app runs without anyone's PC".
 */
async function fetchCloudflareIceServers() {
  const keyId = process.env.CF_TURN_KEY_ID;
  const secret = process.env.CF_TURN_KEY_SECRET;
  if (!keyId || !secret) return null;

  const ttl = Math.min(172800, Math.max(60, Number(process.env.TURN_CREDENTIAL_TTL_SEC) || 600));
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}` +
      '/credentials/generate-ice-servers',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl }),
    },
  );
  if (!res.ok) throw new Error(`Cloudflare TURN endpoint returned ${res.status}`);

  const data = await res.json();
  const raw = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : [];
  const iceServers = raw.map(normalizeServer).filter(Boolean);
  if (!hasTurn(iceServers)) throw new Error('Cloudflare TURN returned no TURN server');

  return {
    iceServers,
    expiresAt: Date.now() + Math.max(60, ttl - 60) * 1000,
    source: 'cloudflare',
  };
}

/** Endpoint list shared by the secret-based and static-credential modes. */
function configuredTurnUrls() {
  const urls = process.env.TURN_URLS;
  if (!urls) return null;
  const list = urls
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  return list.length ? list : null;
}

/**
 * TURN endpoints handed **only** to callers on this machine's network.
 *
 * The two lists answer opposite questions: home routers rarely hairpin NAT, so
 * your public relay address does not work from inside your own LAN, while a
 * private 192.168.x address is useless (and an unnecessary leak) to everyone
 * else. The caller's source address picks the list.
 */
function configuredLocalTurnUrls() {
  const urls = process.env.TURN_URLS_LOCAL;
  if (!urls) return [];
  return urls
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
}

/** Loopback or RFC1918/ULA ⇒ the caller is us or someone on this LAN. */
function isLocalIp(ip) {
  if (!ip) return false;
  const v = String(ip).replace(/^::ffff:/i, '');
  if (v === '::1' || v.startsWith('127.')) return true;
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80:')) return true; // IPv6 ULA / link-local
  return /^10\./.test(v) || /^192\.168\./.test(v) || /^172\.(1[6-9]|2\d|3[01])\./.test(v);
}

/** Static TURN entries from the environment (provider-agnostic). */
function staticTurnIceServers(urls) {
  const username = process.env.TURN_USERNAME;
  const credential = process.env.TURN_CREDENTIAL;
  if (!urls || !username || !credential) return null;

  return [{ urls, username, credential }];
}

function stunOnly(reason) {
  warnOnce(
    `running STUN-only (${reason}). Strict NATs and corporate firewalls will ` +
      'fail to connect — set CF_TURN_KEY_ID/CF_TURN_KEY_SECRET (Cloudflare, free ' +
      'tier), TURN_SECRET/TURN_URLS (coturn), TWILIO_* or ' +
      'TURN_USERNAME/TURN_CREDENTIAL for true global reach. See the TURN block ' +
      'in server/src/iceConfig.js and README → "Deploying TURN".',
  );
  return {
    iceServers: STUN_SERVERS,
    expiresAt: Date.now() + 10 * 60 * 1000,
    source: 'stun-only',
  };
}

/**
 * Resolve the ICE list shared by every caller (cached).
 *
 * Priority: Twilio Network Traversal → static TURN env → STUN only.
 * Failures degrade gracefully: a TURN outage should not take the app down.
 */
async function resolveIce() {
  if (cached && cached.expiresAt - 30 * 1000 > Date.now()) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const twilio = await fetchTwilioIceServers().catch((err) => {
        console.error('[ice] Twilio lookup failed:', err.message);
        return null;
      });

      if (twilio) {
        cached = twilio;
        return cached;
      }

      const cloudflare = await fetchCloudflareIceServers().catch((err) => {
        console.error('[ice] Cloudflare TURN lookup failed:', err.message);
        return null;
      });

      if (cloudflare) {
        cached = cloudflare;
        return cached;
      }

      const urls = configuredTurnUrls();
      const secret = process.env.TURN_SECRET;
      const ttlSeconds = Number(process.env.TURN_CREDENTIAL_TTL_SEC) || 600;

      // Preferred self-hosted mode: coturn --use-auth-secret. The secret never
      // leaves the server and each browser gets a short-lived credential.
      if (urls && secret) {
        const creds = mintRestCreds(secret, ttlSeconds);
        cached = {
          iceServers: [
            ...STUN_SERVERS,
            { urls, username: creds.username, credential: creds.credential },
          ],
          expiresAt: creds.expiresAt,
          source: 'rest-secret',
        };
        return cached;
      }

      const staticTurn = staticTurnIceServers(urls);
      if (staticTurn) {
        cached = {
          iceServers: [...STUN_SERVERS, ...staticTurn],
          expiresAt: Date.now() + 10 * 60 * 1000,
          source: 'static-turn',
        };
        return cached;
      }

      if (urls && !secret) {
        warnOnce(
          'TURN_URLS is set but TURN_SECRET (or TURN_USERNAME + TURN_CREDENTIAL) is ' +
            'missing — serving STUN only.',
        );
      } else if (secret && !urls) {
        warnOnce('TURN_SECRET is set but TURN_URLS is missing — serving STUN only.');
      }

      cached = stunOnly('TURN not configured');
      return cached;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * ICE list for one caller.
 *
 * `local` (derived from the request's source address) prepends the LAN /
 * loopback TURN endpoints: they are the only ones that work from this network
 * — the public relay address needs a hairpin-capable router — and they are
 * pointless, and a small private-address leak, for everyone else.
 * `npm run test:turn` therefore verifies exactly the endpoint a local caller
 * is given, while remote browsers only ever see the public relay.
 */
async function getIceConfig({ local = false } = {}) {
  const base = await resolveIce();
  const localUrls = configuredLocalTurnUrls();
  if (!local || !localUrls.length) return base;

  const turn = (base.iceServers || []).find((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((u) => String(u).startsWith('turn')) && server.username && server.credential;
  });
  if (!turn) return base; // STUN-only — nothing to duplicate

  return {
    ...base,
    iceServers: [{ urls: localUrls, username: turn.username, credential: turn.credential }, ...base.iceServers],
  };
}

/** What the operator actually configured — surfaces in /health and /api/stats. */
function detectSource() {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) return 'twilio';
  if (process.env.CF_TURN_KEY_ID && process.env.CF_TURN_KEY_SECRET) return 'cloudflare';
  if (process.env.TURN_URLS && process.env.TURN_SECRET) return 'rest-secret';
  if (process.env.TURN_URLS && process.env.TURN_USERNAME) return 'static-turn';
  return 'stun-only';
}

function describeIce() {
  const source = cached?.source || detectSource();
  const servers = cached?.iceServers || null;

  // Before the first browser fetch there is no cache — report what the
  // environment says, so /health never claims "TURN not configured" for a
  // server that *is* configured and simply hasn't handed out credentials yet.
  const turn = servers ? hasTurn(servers) : source !== 'stun-only';
  let hosts = [];
  if (turn) {
    if (servers) hosts = turnHosts(servers);
    else if (source === 'twilio') hosts = ['twilio'];
    else if (source === 'cloudflare') hosts = ['turn.cloudflare.com'];
    else if (configuredTurnUrls()) hosts = turnHosts([{ urls: configuredTurnUrls() }]);
  }

  return {
    source,
    /** False ⇒ the "1 in 10 can't connect" cohort has no fallback path. */
    turnConfigured: turn,
    turnHosts: hosts,
    stunHosts: STUN_SERVERS[0].urls.length,
    cachedUntil: cached ? new Date(cached.expiresAt).toISOString() : null,
  };
}

function resetIceCache() {
  cached = null;
  warned = false;
}

module.exports = {
  getIceConfig,
  resetIceCache,
  describeIce,
  isLocalIp,
  STUN_SERVERS,
};
