/**
 * Passport — the country-collection layer that sits on top of matchmaking
 * ("collect the world, one stranger at a time").
 *
 * Every *connected* conversation stamps the partner's country. Two copies of
 * the same data always converge:
 *
 *   • the client keeps it in localStorage, so anonymous visitors get the
 *     feature too and a call never depends on the network to feel rewarding;
 *   • signed-in accounts sync through `POST /api/passport/sync`, which merges
 *     with a per-country **max** — replaying a payload can never inflate a
 *     count, and a fresh device downloads its whole passport in one call.
 *
 * Streaks count consecutive UTC days with at least one new stamp; UTC keeps
 * every device and the server agreeing regardless of timezone.
 *
 * Backends follow `accounts.js`: `maria` (passport_stamps / passport_meta) or
 * an in-process Map for dev / MongoDB setups.
 */
const mariaStore = require('./mariaStore');

/** `maria` = real database, `memory` = process-local (dev / mongo fallback). */
let backend = 'memory';

/** accountId -> { stamps, streak, lastDay } (memory backend) */
const memoryPassports = new Map();

/** Sanity bounds — the whole world is ~250 codes; anything above is abuse. */
const MAX_COUNTRIES = 400;
const MAX_COUNT = 1_000_000;

function init(storeMode) {
  backend = storeMode === 'maria' ? 'maria' : 'memory';
}

const utcDay = () => new Date().toISOString().slice(0, 10);

/** Whole days between two `YYYY-MM-DD` strings (UTC midnight parsing). */
function dayDiff(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Accept only `{ 'CC': int }` entries with sane bounds. Anything malformed is
 * dropped rather than rejected — a bad row on one device must never make a
 * sync fail and lose the good rows next to it.
 */
function sanitize(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let accepted = 0;
  for (const key of Object.keys(raw)) {
    if (accepted >= MAX_COUNTRIES) break;
    const cc = String(key).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) continue;
    const value = Math.floor(Number(raw[key]));
    if (!Number.isFinite(value) || value < 1) continue;
    out[cc] = Math.min(value, MAX_COUNT);
    accepted += 1;
  }
  return out;
}

function summarize(stamps, streak, lastDay) {
  let total = 0;
  for (const count of Object.values(stamps)) total += count;
  return {
    stamps,
    unique: Object.keys(stamps).length,
    total,
    streak,
    lastDay,
  };
}

/**
 * Merge the client's stamps into the stored passport and return the union.
 * The streak only advances when the merge actually added something (a new
 * country or a higher count) — replaying today's sync is a no-op.
 */
async function sync(accountId, rawStamps) {
  const incoming = sanitize(rawStamps);

  const stored =
    backend === 'maria'
      ? await mariaStore.loadPassport(accountId)
      : memoryPassports.get(accountId) || { stamps: {}, streak: 0, lastDay: null };

  const stamps = { ...stored.stamps };
  let touched = false;
  for (const [cc, value] of Object.entries(incoming)) {
    const previous = stamps[cc] || 0;
    if (value > previous) {
      stamps[cc] = value;
      touched = true;
    }
  }

  let streak = stored.streak || 0;
  let lastDay = stored.lastDay || null;
  if (touched) {
    const today = utcDay();
    if (lastDay === today) {
      // Already counted today — the flame keeps burning, nothing to add.
    } else if (lastDay && dayDiff(lastDay, today) === 1) {
      streak += 1;
    } else {
      streak = 1; // first stamp, or the chain was broken yesterday
    }
    lastDay = today;
  }

  if (backend === 'maria') {
    // Always persist: a pure pull (empty incoming) still converges the row.
    await mariaStore.savePassport(accountId, stamps, streak, lastDay);
  } else if (Object.keys(stamps).length > 0) {
    memoryPassports.set(accountId, { stamps, streak, lastDay });
  }

  return summarize(stamps, streak, lastDay);
}

module.exports = {
  init,
  sync,
  /** Test seam: wipe the in-memory backend between suites. */
  _reset() {
    memoryPassports.clear();
  },
};
