/**
 * Media transport configuration — app-server relay, no STUN/TURN.
 *
 * Matchup no longer asks browsers to discover public addresses or traverse
 * NATs. The server receives encoded media chunks over the existing signaling
 * channel and forwards them to the partner. This works on any network that
 * can reach the app, including CGNAT, strict corporate firewalls and mobile
 * carriers.
 *
 * `GET /api/ice` is kept for diagnostics and returns an empty ICE list with
 * `source: "relay"`. No STUN or TURN URL is configured anywhere.
 */

const CACHE_TTL_MS = 10 * 60 * 1000;
let cached = null;

function buildConfig() {
  return {
    iceServers: [],
    expiresAt: Date.now() + CACHE_TTL_MS,
    source: 'relay',
  };
}

/** Resolve the media transport config (cached, no credentials, no lookup). */
async function getIceConfig() {
  if (cached && cached.expiresAt - 30 * 1000 > Date.now()) return cached;
  cached = buildConfig();
  return cached;
}

/** What the operator configured — surfaces in `/health` and `/api/stats`. */
function describeIce() {
  return {
    source: 'relay',
    transport: 'http-long-poll',
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
};
