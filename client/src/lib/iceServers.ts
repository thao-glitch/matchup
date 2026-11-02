/**
 * Media transport configuration.
 *
 * Matchup does not use STUN or TURN. Instead, the app server relays encoded
 * media chunks between the two callers over the existing authenticated
 * signaling channel. The browser's `RTCPeerConnection` is not used for the
 * call at all, so there are no ICE servers, no public STUN lookups and no NAT
 * traversal dependency.
 *
 * `GET /api/ice` still exists for diagnostics and returns an empty ICE list
 * with `source: "relay"`. Keeping the endpoint means older clients and the
 * admin health page do not break while the transport changes.
 */

/** Signaling base URL. Empty string ⇒ same origin (Vite dev proxy / same host). */
export const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL ?? '';

export interface IceConfig {
  /** Always empty in relay mode. */
  iceServers: RTCIceServer[];
  /** Epoch ms after which the config should be refreshed. */
  expiresAt: number;
  /** `relay` — media goes through the app server, never STUN/TURN. */
  source: string;
}

/**
 * Resolve the media transport configuration.
 *
 * There is no network request and nothing to cache: the relay is the only
 * transport. The function stays async because callers (and older bundles)
 * expect a promise.
 */
export async function getIceConfig(): Promise<IceConfig> {
  return {
    iceServers: [],
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    source: 'relay',
  };
}

/** Kept for API parity with the old STUN cache. */
export function resetIceCache(): void {
  /* nothing to reset */
}
