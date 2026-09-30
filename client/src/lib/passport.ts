/**
 * The Passport — "collect the world, one stranger at a time".
 *
 * localStorage is the always-available source of truth: it works signed-out,
 * offline, and mid-call without a round-trip. Signed-in users additionally
 * merge with the server (`POST /api/passport/sync`, per-country max), so the
 * collection follows them to any device — see `server/src/passport.js`.
 *
 * Days are UTC on every side, so two devices and the server never disagree
 * about whether the streak survived.
 */
import { getToken } from './auth';
import { SIGNALING_URL } from './iceServers';

const KEY = 'matchup.passport.v1';
const SYNC_URL = `${SIGNALING_URL.replace(/\/$/, '')}/api/passport/sync`;

export interface PassportState {
  /** ISO country code -> how many connected calls happened with someone there. */
  stamps: Record<string, number>;
  /** Consecutive UTC days with at least one stamp. */
  streak: number;
  /** `YYYY-MM-DD` of the last stamped day (UTC), `null` before the first. */
  lastDay: string | null;
}

const EMPTY: PassportState = { stamps: {}, streak: 0, lastDay: null };

function load(): PassportState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<PassportState>;
    const stamps: Record<string, number> = {};
    if (parsed.stamps && typeof parsed.stamps === 'object') {
      for (const [cc, n] of Object.entries(parsed.stamps)) {
        const code = cc.toUpperCase();
        const count = Math.floor(Number(n));
        if (/^[A-Z]{2}$/.test(code) && Number.isFinite(count) && count > 0) {
          stamps[code] = count;
        }
      }
    }
    return {
      stamps,
      streak: Math.max(0, Math.floor(Number(parsed.streak) || 0)),
      lastDay: typeof parsed.lastDay === 'string' ? parsed.lastDay : null,
    };
  } catch {
    return { ...EMPTY };
  }
}

let state: PassportState = load();

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private mode / quota — the session just doesn't persist */
  }
}

const utcDay = () => new Date().toISOString().slice(0, 10);

function dayDiff(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

/** Fresh read for overlays/screens — cheap, always current. */
export function passportState(): PassportState {
  return state;
}

export function uniqueCountries(): number {
  return Object.keys(state.stamps).length;
}

export function totalMatches(): number {
  let total = 0;
  for (const n of Object.values(state.stamps)) total += n;
  return total;
}

export interface StampResult {
  /** Partner's ISO country code. */
  code: string;
  /** First time this country was stamped — the celebration-worthy case. */
  isNew: boolean;
  /** Distinct countries after the stamp. */
  unique: number;
  /** Consecutive UTC days with at least one stamp. */
  streak: number;
}

/**
 * Stamp a connected conversation's country. Returns `null` for a malformed
 * code — a bad peer profile must not break the post-call screen. Syncs to the
 * server in the background when signed in (fire-and-forget).
 */
export function addStamp(rawCountry: string): StampResult | null {
  const code = String(rawCountry || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;

  const isNew = !(code in state.stamps);
  state.stamps[code] = (state.stamps[code] || 0) + 1;

  const today = utcDay();
  if (state.lastDay !== today) {
    state.streak = state.lastDay && dayDiff(state.lastDay, today) === 1 ? state.streak + 1 : 1;
    state.lastDay = today;
  }
  save();

  if (getToken()) void syncPassport();

  return { code, isNew, unique: Object.keys(state.stamps).length, streak: state.streak };
}

/**
 * Merge local stamps into the server's passport and adopt anything the server
 * has that this device doesn't. Never throws and never blocks the UI — offline
 * is a normal state; the next stamp or login retries.
 */
export async function syncPassport(): Promise<void> {
  const token = getToken();
  if (!token) return;
  try {
    const res = await fetch(SYNC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ stamps: state.stamps }),
      cache: 'no-store',
    });
    if (!res.ok) return;
    const data = (await res.json()) as {
      stamps?: Record<string, number>;
      streak?: number;
    };
    let changed = false;
    for (const [cc, n] of Object.entries(data.stamps || {})) {
      const code = cc.toUpperCase();
      const count = Math.floor(Number(n));
      if (/^[A-Z]{2}$/.test(code) && Number.isFinite(count) && count > 0) {
        if ((state.stamps[code] || 0) < count) {
          state.stamps[code] = count;
          changed = true;
        }
      }
    }
    if (Number(data.streak) > state.streak) {
      state.streak = Math.floor(Number(data.streak));
      changed = true;
    }
    if (changed) save();
  } catch {
    /* offline / server hiccup — the local copy is already merged */
  }
}

export interface PassportBadge {
  id: string;
  icon: string;
  label: string;
  hint: string;
  earned: boolean;
}

/** The six achievements — the long road that keeps people coming back. */
export function badges(): PassportBadge[] {
  const u = uniqueCountries();
  const t = totalMatches();
  return [
    { id: 'first', icon: '🌱', label: 'First contact', hint: 'Stamp 1 country', earned: u >= 1 },
    { id: 'explorer', icon: '🧭', label: 'Explorer', hint: '5 countries', earned: u >= 5 },
    {
      id: 'globetrotter',
      icon: '🌍',
      label: 'Globetrotter',
      hint: '15 countries',
      earned: u >= 15,
    },
    {
      id: 'streak7',
      icon: '🔥',
      label: 'Week of wandering',
      hint: '7-day streak',
      earned: state.streak >= 7,
    },
    { id: 'flow', icon: '💬', label: 'In the flow', hint: '25 calls', earned: t >= 25 },
    { id: 'centurion', icon: '🏆', label: 'Centurion', hint: '100 calls', earned: t >= 100 },
  ];
}
