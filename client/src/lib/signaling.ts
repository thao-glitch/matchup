import { io, type Socket } from 'socket.io-client';
import type {
  CallEventMessage,
  CallReport,
  MatchInfo,
  PeerProfile,
  Profile,
  SignalMessage,
  WaitingStatus,
} from '../types';
import { SIGNALING_URL } from './iceServers';

/**
 * Typed Socket.io contract.
 *
 * Keep in sync with `server/src/protocol.js` (the server is plain JS on
 * purpose: it must run on any Node host without a build step).
 */
export interface ServerToClientEvents {
  /** A partner was found — start the WebRTC handshake. */
  'match:found': (match: MatchInfo) => void;
  /** Still queued: carries the live presence counters. */
  'match:waiting': (status: WaitingStatus) => void;
  /** SDP/ICE relayed from the partner (filtered server-side by room). */
  'signal:data': (msg: SignalMessage) => void;
  /** Playground event (chat/reaction/spark/duel) relayed from the partner. */
  'call:event': (msg: CallEventMessage) => void;
  /** Partner hung up or dropped. */
  'peer:left': (info: { roomId: string; reason: 'ended' | 'disconnected' }) => void;
  /** Pushed every few seconds while queued. */
  presence: (status: WaitingStatus) => void;
  /** Validation / rate-limit / internal errors that are safe to show. */
  'server:error': (info: { code: string; message: string }) => void;
}

export interface ClientToServerEvents {
  'queue:join': (profile: Profile) => void;
  'queue:leave': () => void;
  'signal:data': (msg: SignalMessage) => void;
  'call:event': (msg: CallEventMessage) => void;
  'call:end': () => void;
  /** Telemetry: how the call resolved (path/RTT/duration). See `CallReport`. */
  'call:report': (report: CallReport) => void;
}

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Build the signaling socket.
 *
 * `websocket` first keeps SDP relay latency in the low single-digit ms;
 * `polling` remains as a transport fallback for networks that block WS.
 */
export function createSignalingSocket(): AppSocket {
  const url = SIGNALING_URL.replace(/\/$/, '') || '/';
  return io(url, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000,
    timeout: 10_000,
    // Avoids a surprise burst of reconnects when a laptop resumes from sleep.
    randomizationFactor: 0.4,
  });
}

/** Normalize a profile before it leaves the client (server re-validates). */
export function normalizeProfile(profile: Profile): Profile {
  const preferred =
    profile.preferredGenders.length > 0 ? profile.preferredGenders : (['any'] as const);
  return {
    ...profile,
    username: profile.username.trim().slice(0, 24),
    preferredGenders: [...preferred],
    ageMin: Math.max(18, Math.min(profile.ageMin, 99)),
    ageMax: Math.min(99, Math.max(profile.ageMax, 18)),
  };
}

export type {
  CallEventMessage,
  CallReport,
  MatchInfo,
  PeerProfile,
  Profile,
  SignalMessage,
  WaitingStatus,
};
