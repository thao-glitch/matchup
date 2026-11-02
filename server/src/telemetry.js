/**
 * Call outcome telemetry — a live view of whether direct peer connections
 * are working.
 *
 * Each client reports once per room (`call:report`) with the selected ICE
 * candidate-pair type, RTT and duration. From that we can answer:
 *
 *   • how many matched pairs actually reach "connected"?   (success rate)
 *   • which path did they use — LAN, STUN, or unknown?     (path mix)
 *   • how many users never found a direct path?            (failed calls)
 *
 * Reports are keyed by roomId so a retry after a failed attempt converges on
 * one row instead of double counting. Everything is in-memory: it is an
 * operational readout, not an analytics warehouse (see README → Scaling).
 */

const OUTCOMES = new Set(['connected', 'failed']);
const PATHS = new Set(['host', 'srflx', 'prflx', 'unknown']);

/** Cap so a long-lived process cannot grow without bound. */
const MAX_ROOMS = 2000;
const MAX_RECENT = 8;

/** @type {Map<string, object>} roomId -> normalized report (insertion order = oldest first) */
const rooms = new Map();
let reports = 0;
let dropped = 0;
let since = Date.now();

function num(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function str(value, allowed, fallback) {
  const s = typeof value === 'string' ? value : '';
  return allowed.has(s) ? s : fallback;
}

/**
 * Normalize + store one report. Malformed payloads are counted (not thrown):
 * the client is untrusted, but a broken report should never kill a call.
 * @returns {null | 'stored'}
 */
function record(raw) {
  reports += 1;
  if (!raw || typeof raw !== 'object' || typeof raw.roomId !== 'string') {
    dropped += 1;
    return null;
  }
  const roomId = raw.roomId.slice(0, 40);
  if (!/^r_[0-9a-f]{6,40}$/.test(roomId)) {
    dropped += 1;
    return null;
  }

  const report = {
    roomId,
    outcome: str(raw.outcome, OUTCOMES, 'failed'),
    path: str(raw.path, PATHS, 'unknown'),
    rttMs: num(raw.rttMs, 0, 60_000),
    durationMs: num(raw.durationMs, 0, 24 * 3600 * 1000),
    attempts: num(raw.attempts, 1, 99) ?? 1,
    iceSource: str(raw.iceSource, new Set(['stun-only']), 'unknown'),
    at: Date.now(),
  };

  // Last write wins: a retry that finally connects replaces the "failed" row.
  if (rooms.has(roomId)) rooms.delete(roomId);
  rooms.set(roomId, report);
  while (rooms.size > MAX_ROOMS) {
    rooms.delete(rooms.keys().next().value);
  }
  return 'stored';
}

function avg(values) {
  if (!values.length) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function snapshot() {
  const all = [...rooms.values()];
  const connected = all.filter((r) => r.outcome === 'connected');
  const failed = all.filter((r) => r.outcome === 'failed');

  const byPath = { host: 0, srflx: 0, prflx: 0, unknown: 0 };
  const bySource = { 'stun-only': 0, unknown: 0 };
  for (const r of all) {
    byPath[r.path] += 1;
    bySource[r.iceSource] += 1;
  }

  const rtt = connected.map((r) => r.rttMs).filter((v) => v != null);
  const durations = connected.map((r) => r.durationMs).filter((v) => v != null);

  return {
    since: new Date(since).toISOString(),
    rooms: all.length,
    reports,
    dropped,
    outcomes: {
      connected: connected.length,
      failed: failed.length,
      /** 0–100; `null` until the first resolved call exists. */
      successRate: all.length
        ? Math.round((connected.length / all.length) * 1000) / 10
        : null,
    },
    paths: byPath,
    iceSources: bySource,
    rttMs: { samples: rtt.length, avg: avg(rtt) },
    durationMs: { samples: durations.length, avg: avg(durations) },
    recent: all.slice(-MAX_RECENT).reverse(),
  };
}

function reset() {
  rooms.clear();
  reports = 0;
  dropped = 0;
  since = Date.now();
}

module.exports = { record, snapshot, reset };
