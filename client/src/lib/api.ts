/**
 * Small HTTP client for the signaling server's public read-only endpoints.
 * Everything else in the app travels over Socket.io; this is only for data
 * that must be fetchable by a page (the Europe board) without a live socket.
 */
import { SIGNALING_URL } from './iceServers';

/** `GET /api/presence` — live, aggregate-only online counts. */
export interface GeoPresence {
  /** Sockets connected to the signaling server right now. */
  online: number;
  /** People currently sitting in a queue. */
  looking: number;
  /** How many of `online` submitted a profile and could be located. */
  located: number;
  /** Sorted by count, most online first. Aggregate only — never individual. */
  byCountry: { code: string; online: number }[];
}

const BASE = SIGNALING_URL.replace(/\/$/, '');

export async function fetchPresence(signal?: AbortSignal): Promise<GeoPresence> {
  const res = await fetch(`${BASE}/api/presence`, {
    headers: { accept: 'application/json' },
    // Counts change every second; a cached copy would be a lie.
    cache: 'no-store',
    signal,
  });
  if (!res.ok) throw new Error(`presence endpoint returned ${res.status}`);

  const data = (await res.json()) as Partial<GeoPresence>;
  return {
    online: typeof data.online === 'number' ? data.online : 0,
    looking: typeof data.looking === 'number' ? data.looking : 0,
    located: typeof data.located === 'number' ? data.located : 0,
    byCountry: Array.isArray(data.byCountry)
      ? data.byCountry.filter(
          (row) =>
            row &&
            typeof row.code === 'string' &&
            row.code.length === 2 &&
            typeof row.online === 'number',
        )
      : [],
  };
}
