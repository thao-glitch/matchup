/**
 * ICE server configuration — the single most important knob for global reach.
 *
 * ┌─ How WebRTC finds a path between two peers ────────────────────────────────┐
 * │ STUN  → discovers each side's public IP:port (works for ~85-90% of NATs).  │
 * │ TURN  → relays the packets when discovery fails: symmetric NAT, double NAT,│
 * │         CGNAT, strict corporate/firewall policies. Without TURN those      │
 * │         users simply never connect — this is the "1 in 10 users can't      │
 * │         call anyone" problem.                                              │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * The browser fetches fresh, time-limited TURN credentials from the signaling
 * server (`GET /api/ice`) rather than baking secrets into the JS bundle.
 * See `server/src/iceConfig.js` for the Twilio Network Traversal integration.
 */

/** Signaling base URL. Empty string ⇒ same origin (Vite dev proxy / same host). */
export const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL ?? '';

const ICE_URL =
  import.meta.env.VITE_ICE_URL ?? `${SIGNALING_URL.replace(/\/$/, '')}/api/ice`;

/**
 * STUN-only fallback used before the first `/api/ice` response lands — or if
 * that request fails. STUN is public, unlimited and free; it just can't punch
 * through every NAT.
 */
export const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

/**
 * TURN credentials live on the *server* (`server/src/iceConfig.js`); this
 * client only ever fetches them from `GET /api/ice`.
 *
 * Configure TURN with one of (server env, see `server/.env.example`):
 *   • TURN_URLS + TURN_SECRET      → coturn REST API, short-lived credentials
 *   • TWILIO_ACCOUNT_SID/AUTH_TOKEN → Twilio Network Traversal
 *   • TURN_URLS + TURN_USERNAME/CREDENTIAL → any static TURN provider
 *
 * Until one of those is set the server answers STUN-only and roughly one in
 * ten users behind symmetric NAT / CGNAT will hit "Unable to connect".
 */
export interface IceConfig {
  iceServers: RTCIceServer[];
  /** Epoch ms after which the credentials expire. */
  expiresAt: number;
  /** Which backend minted them: twilio | rest-secret | static-turn | stun-only. */
  source: string;
}

let cached: IceConfig | null = null;
let inflight: Promise<IceConfig> | null = null;

function isUsable(server: RTCIceServer): boolean {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  const isTurn = urls.some((u) => String(u).startsWith('turn'));
  // Never hand a TURN server without credentials to RTCPeerConnection — the
  // browser would waste an ICE round trying and failing on it.
  return !isTurn || Boolean(server.username && server.credential);
}

/**
 * Resolve ICE servers, caching until shortly before the TURN credentials
 * expire so a long-lived tab keeps working across credential rotations.
 */
export async function getIceConfig(): Promise<IceConfig> {
  if (cached && cached.expiresAt - 30_000 > Date.now()) return cached;
  if (inflight) return inflight;

  inflight = (async (): Promise<IceConfig> => {
    try {
      const res = await fetch(ICE_URL, {
        headers: { accept: 'application/json' },
        // Credentials change per response; never serve a stale copy.
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
        source: data.source ?? 'unknown',
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
