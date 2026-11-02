/**
 * ICE server configuration — public STUN only.
 *
 * STUN discovers each side's public IP:port so two browsers can connect
 * directly. There is no TURN relay in this app: video, audio and the in-call
 * chat stay peer-to-peer, and a call that cannot find a direct path fails
 * cleanly instead of silently routing media through a relay.
 *
 * The list is fetched from `GET /api/ice` at call time. A local STUN fallback
 * keeps calls working even if that request is temporarily unavailable.
 */

/** Signaling base URL. Empty string ⇒ same origin (Vite dev proxy / same host). */
export const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL ?? '';

const ICE_URL =
  import.meta.env.VITE_ICE_URL ?? `${SIGNALING_URL.replace(/\/$/, '')}/api/ice`;

/**
 * STUN-only fallback used before the first `/api/ice` response lands — or if
 * that request fails. STUN is public, unlimited and free.
 */
export const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

export interface IceConfig {
  iceServers: RTCIceServer[];
  /** Epoch ms after which the list should be refreshed. */
  expiresAt: number;
  /** This app only serves `stun-only`; the field is kept for diagnostics. */
  source: string;
}

let cached: IceConfig | null = null;
let inflight: Promise<IceConfig> | null = null;

/**
 * ICE URL syntax check. One malformed URL makes the browser reject the whole
 * RTCConfiguration, so every URL must parse before we hand the list over.
 */
const ICE_URL_RE =
  /^(stuns?):(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(:\d{1,5})?(\?\S*)?$/;

function isUsable(server: RTCIceServer): boolean {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  return urls.length > 0 && urls.every((u) => ICE_URL_RE.test(String(u)));
}

/**
 * Resolve ICE servers, caching until shortly before the list expires.
 */
export async function getIceConfig(): Promise<IceConfig> {
  if (cached && cached.expiresAt - 30_000 > Date.now()) return cached;
  if (inflight) return inflight;

  inflight = (async (): Promise<IceConfig> => {
    try {
      const res = await fetch(ICE_URL, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`ICE endpoint returned ${res.status}`);
      const data = (await res.json()) as {
        iceServers?: RTCIceServer[];
        expiresAt?: number;
        source?: string;
      };
      const iceServers = (data.iceServers ?? []).filter(isUsable);
      if (iceServers.length === 0) throw new Error('no usable ICE servers');

      cached = {
        iceServers,
        expiresAt:
          typeof data.expiresAt === 'number'
            ? data.expiresAt
            : Date.now() + 10 * 60_000,
        source: data.source ?? 'stun-only',
      };
      return cached;
    } catch (err) {
      // STUN-only is a legitimate degraded mode: keep the app usable rather
      // than blocking the call on a config fetch.
      console.warn('[ice] falling back to STUN-only:', err);
      cached = {
        iceServers: FALLBACK_ICE_SERVERS,
        expiresAt: Date.now() + 5 * 60_000,
        source: 'stun-only',
      };
      return cached;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** Test seam / manual reset after a hard failure. */
export function resetIceCache(): void {
  cached = null;
}
