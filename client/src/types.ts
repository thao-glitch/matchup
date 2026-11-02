/**
 * Shared domain types for the Matchup client.
 *
 * The signaling contract (event names + payloads) is mirrored on the server in
 * `server/src/protocol.js`. Keep the two in sync — there is intentionally no
 * cross-package import so the client bundle never pulls in Node code.
 */

export const GENDERS = ['female', 'male', 'nonbinary', 'other'] as const;
export type Gender = (typeof GENDERS)[number];

export const PREFERENCES = ['any', ...GENDERS] as const;
export type Preference = (typeof PREFERENCES)[number];

/** What the user fills in on the lobby form. */
export interface Profile {
  username: string;
  age: number;
  gender: Gender;
  /** ISO-3166 alpha-2 code (e.g. "KE") resolved client-side from the browser. */
  country: string;
  /** Who the user wants to be matched with. Empty array is normalized to ["any"]. */
  preferredGenders: Preference[];
  /** Inclusive age range the user is willing to be matched with. */
  ageMin: number;
  ageMax: number;
}

/** The server-side account: what `/api/auth/*` returns once you are signed in. */
export interface AccountUser {
  /** Internal row id — also the `{id}` in a paybill Account Number. */
  id?: number;
  username: string;
  profile: Profile;
  createdAt?: string | null;
  /** Premium entitlement: ISO timestamp of when it runs out, or null. */
  premiumUntil?: string | null;
}

/**
 * One premium purchase as the buyer sees it (`/api/payments/*`).
 *
 * This is a charge, not a reference: the phone was prompted for its PIN and
 * Daraja answers for itself, so there is no account number to copy and no
 * "I have paid" button to press. `premiumUntil` is read fresh from the row
 * that settles, because the callback may have just changed it.
 */
export interface PremiumPayment {
  id: number;
  /** `pending` → the phone has the prompt up; `paid` → premium is live. */
  status: 'pending' | 'paid' | 'failed' | 'expired';
  amount: number;
  currency: string;
  /** The period quoted when the prompt was sent, stamped onto the charge. */
  premiumDays: number | null;
  phone: string;
  /** The M-PESA receipt, once one exists. */
  mpesaRef: string | null;
  /** Why it failed — only set on a `failed` charge. */
  error: string | null;
  createdAt: string | null;
  paidAt: string | null;
  premiumUntil: string | null;
}

/** The subset of a profile that is ever shared with the other side of a match. */
export interface PeerProfile {
  username: string;
  age: number;
  gender: Gender;
  country: string;
}

export interface MatchInfo {
  roomId: string;
  peer: PeerProfile;
  /**
   * `true` for the peer that creates the SDP offer. Exactly one side of every
   * match receives `initiator: true`; it is what breaks offer/answer glare.
   */
  initiator: boolean;
}

export interface WaitingStatus {
  /** People currently sitting in a queue (themselves included). */
  looking: number;
  /** People connected to the signaling server right now. */
  online: number;
}

/**
 * What a finished, *connected* call can put on its shareable card. Country
 * codes and duration only — never a name, age or face (see `lib/postcard.ts`).
 */
export interface ShareMeta {
  /** Your own profile's country code. */
  myCountry: string;
  /** The partner's country code, as sent with `match:found`. */
  peerCountry: string;
  /** Seconds the call was actually connected. */
  seconds: number;
  /** Distinct passport countries after this call — 0 hides the line. */
  passport?: number;
}

/**
 * The passport stamp a finished, connected call produced — drives the
 * celebration banner on the post-call screen.
 */
export interface StampInfo {
  /** Partner's ISO country code. */
  code: string;
  /** First time this country was stamped. */
  isNew: boolean;
  /** Distinct countries after the stamp. */
  unique: number;
  /** Consecutive UTC days with at least one stamp. */
  streak: number;
}

/** One encoded media slice relayed through the app server. */
export interface MediaChunk {
  /** MediaRecorder mime type, e.g. `video/webm;codecs=vp8,opus`. */
  mime: string;
  /** Monotonic sequence number, useful when debugging dropped slices. */
  seq: number;
  /** Base64-encoded MediaRecorder blob. */
  data: string;
}

/** Signaling and media both travel through the server; no STUN/TURN. */
export interface SignalMessage {
  roomId: string;
  kind: 'offer' | 'answer' | 'candidate' | 'media';
  payload: RTCSessionDescriptionInit | RTCIceCandidateInit | MediaChunk;
}

export type CallState =
  | 'connecting' // ICE/DTLS in progress
  | 'connected' // media flowing
  | 'reconnecting' // transient ICE hiccup, restart in flight
  | 'failed' // gave up — surface "Unable to connect"
  | 'closed'; // peer torn down

export type AppError = {
  code:
    | 'media-denied'
    | 'media-missing'
    | 'signaling-down'
    | 'peer-timeout'
    | 'server';
  title: string;
  message: string;
};

/** `host` = LAN, `srflx`/`prflx` = legacy direct paths, `relay` = app server. */
export type PathType = 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown';

export interface NetworkStats {
  path: PathType;
  rttMs: number | null;
  /** Round-trip of the ICE checks in ms — a good proxy for "feel". */
  protocol: string | null;
}

/** Where media is transported (this app serves `relay`). */
export type IceSource = 'relay';

/** The in-call playground channels relayed through `call:event`. */
export type CallEventType = 'chat' | 'react' | 'spark' | 'duel';

/** One in-call playground event, relayed partner-to-partner by the server. */
export interface CallEventMessage {
  roomId: string;
  type: CallEventType;
  payload: Record<string, string | number>;
}

/** A single chat line rendered in the in-call chat drawer. */
export interface ChatMessage {
  id: number;
  mine: boolean;
  text: string;
}

/**
 * One telemetry row per call (`call:report`). The server keys rows by
 * `roomId`, so a retry after a failed attempt converges instead of double
 * counting — send it again whenever the outcome changes.
 */
export interface CallReport {
  roomId: string;
  outcome: 'connected' | 'failed';
  /** Selected transport: host, srflx, prflx or the app relay. */
  path?: PathType | null;
  rttMs?: number | null;
  durationMs?: number | null;
  /** Connection attempts burned (ICE restarts / retries). */
  attempts?: number;
  iceSource?: IceSource | 'unknown';
}
