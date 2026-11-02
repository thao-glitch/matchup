/**
 * ICE server configuration — public STUN only.
 *
 * Matchup connects two browsers directly. STUN discovers each side's public
 * IP:port so the peers can punch through ordinary home routers. No TURN relay
 * is configured or required: if two networks cannot build a direct path, the
 * call fails cleanly and the user can retry or find someone else.
 *
 * The browser fetches this list from `GET /api/ice`, so the client bundle
 * never hard-codes the list and the server can change it without a rebuild.
 */

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

const CACHE_TTL_MS = 10 * 60 * 1000;
let cached = null;

function buildConfig() {
  return {
    iceServers: STUN_SERVERS,
    expiresAt: Date.now() + CACHE_TTL_MS,
    source: 'stun-only',
  };
}

/**
 * Resolve the ICE list shared by every caller.
 *
 * The list is cached for a few minutes so every call in a busy process does
 * not rebuild it. There are no credentials and no network lookup involved.
 */
async function getIceConfig() {
  if (cached && cached.expiresAt - 30 * 1000 > Date.now()) return cached;
  cached = buildConfig();
  return cached;
}

/** What the operator configured — surfaces in `/health` and `/api/stats`. */
function describeIce() {
  return {
    source: 'stun-only',
    stunHosts: STUN_SERVERS[0].urls.length,
    cachedUntil: cached ? new Date(cached.expiresAt).toISOString() : null,
  };
}

function resetIceCache() {
  cached = null;
}

module.exports = {
  getIceConfig,
  resetIceCache,
  describeIce,
  STUN_SERVERS,
};
