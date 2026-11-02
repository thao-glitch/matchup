import type {
  CallEventMessage,
  CallReport,
  MatchInfo,
  PeerProfile,
  Profile,
  SignalMessage,
  WaitingStatus,
} from '../types';
import type { Room, RoomPeer } from '../types/social';
import { SIGNALING_URL } from './iceServers';

/**
 * Typed realtime contract — keep in sync with `server/src/protocol.js`.
 *
 * The transport is no longer socket.io: the backend runs as serverless
 * functions, which cannot hold a connection open or remember a socket across
 * requests. Everything below rides two HTTP endpoints instead:
 *
 *   POST /api/rt/emit            client → server, fire and forget
 *   GET  /api/rt/poll?since=N    server → client, long-poll (holds ~20s)
 *
 * Server events arrive as rows addressed to a per-page-load session id
 * (`x-matchup-sid`); presence and queue position ride along on every poll, so
 * the app code — which still registers `socket.on('match:found', …)` — is
 * unchanged.
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
  /** Pushed on every poll while the counters changed. */
  presence: (status: WaitingStatus) => void;
  /** Validation / rate-limit / internal errors that are safe to show. */
  'server:error': (info: { code: string; message: string }) => void;
  /** Group room: the room you created is open (you are already inside it). */
  'room:created': (msg: { room: Room }) => void;
  /** Group room: you are in — `peers` is who to dial (see `RoomPeer`). */
  'room:joined': (msg: { room: Room; self: RoomPeer; peers: RoomPeer[] }) => void;
  /** Group room: SDP/ICE from ONE other participant (mesh relay). */
  'room:signal': (msg: {
    slug: string;
    from: number;
    username?: string;
    kind: 'offer' | 'answer' | 'candidate' | 'media';
    payload: unknown;
  }) => void;
  /** Group room: the roster changed — sync your peer connections to it. */
  'room:state': (msg: { slug: string; participants: RoomPeer[]; count: number }) => void;
  /** Group room: the host (or the dashboard) closed it for everyone. */
  'room:closed': (msg: { slug: string; byAdmin?: boolean }) => void;
  /** Transport lifecycle (emitted by this shim, not the server). */
  connect: () => void;
  connect_error: (err: Error) => void;
  disconnect: () => void;
}

export interface ClientToServerEvents {
  'queue:join': (profile: Profile) => void;
  'queue:leave': () => void;
  'signal:data': (msg: SignalMessage) => void;
  'call:event': (msg: CallEventMessage) => void;
  'call:end': () => void;
  /** Telemetry: how the call resolved (path/RTT/duration). See `CallReport`. */
  'call:report': (report: CallReport) => void;
  /** Group rooms — `token` authenticates the socket (rooms are never anonymous). */
  'room:create': (msg: {
    token: string;
    title: string;
    price: number;
    isAdult: boolean;
    max: number;
    kind: 'group' | 'conference';
  }) => void;
  'room:enter': (msg: { token: string; slug: string }) => void;
  'room:signal': (msg: {
    slug: string;
    to: number;
    kind: 'offer' | 'answer' | 'candidate' | 'media';
    payload: unknown;
  }) => void;
  'room:leave': (msg: { slug: string }) => void;
  'room:end': (msg: { token: string; slug: string }) => void;
}

/** The subset of the old socket.io `Socket` API this app uses. */
export interface AppSocket {
  on<K extends keyof ServerToClientEvents>(
    event: K,
    cb: ServerToClientEvents[K],
  ): AppSocket;
  off<K extends keyof ServerToClientEvents>(
    event: K,
    cb?: ServerToClientEvents[K],
  ): AppSocket;
  emit<K extends keyof ClientToServerEvents>(
    event: K,
    ...args: Parameters<ClientToServerEvents[K]>
  ): void;
  connect(): void;
  disconnect(): void;
  readonly connected: boolean;
  /** Present for API parity with socket.io — `reconnect_failed` never fires
   *  because this shim retries forever, which is the whole point. */
  readonly io: {
    on(event: string, cb: (...args: unknown[]) => void): void;
    off(event: string, cb?: (...args: unknown[]) => void): void;
  };
  /** socket.io parity: drop every registered handler at once. */
  removeAllListeners(): AppSocket;
  /** Set by App.tsx to time calls; not part of the protocol. */
  connectedAt?: number;
}

const BASE = SIGNALING_URL.replace(/\/$/, '');
const RT = `${BASE}/api/rt`;
/** Long-poll hold; the server caps its own wait, this just waits longer. */
const POLL_WAIT_SEC = 22;
const POLL_TIMEOUT_MS = (POLL_WAIT_SEC + 10) * 1000;
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 4000;

function makeSid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `sid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

class PollingSocket implements AppSocket {
  readonly sid = makeSid();
  connected = false;
  connectedAt: number | undefined;

  private handlers = new Map<string, Set<(...args: never[]) => void>>();
  private cursor = 0;
  private wanted = false;
  private lastPresence = '';
  private lastWaiting = '';

  readonly io = {
    on() {
      /* `reconnect_failed` cannot happen: the retry loop never gives up. */
    },
    off() {
      /* Nothing was ever registered — kept for socket.io API parity. */
    },
  };

  on<K extends keyof ServerToClientEvents>(event: K, cb: ServerToClientEvents[K]) {
    let set = this.handlers.get(event as string);
    if (!set) {
      set = new Set();
      this.handlers.set(event as string, set);
    }
    set.add(cb as (...args: never[]) => void);
    return this;
  }

  off<K extends keyof ServerToClientEvents>(event: K, cb?: ServerToClientEvents[K]) {
    const set = this.handlers.get(event as string);
    if (!set) return this;
    if (cb) set.delete(cb as (...args: never[]) => void);
    else set.clear();
    return this;
  }

  removeAllListeners() {
    this.handlers.clear();
    return this;
  }

  private dispatch(event: string, payload?: unknown) {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        (cb as (p?: unknown) => void)(payload);
      } catch (err) {
        console.error(`[signaling] handler for "${event}" threw:`, err);
      }
    }
  }

  /** Client → server. Fire and forget: the long-poll reports connectivity. */
  emit<K extends keyof ClientToServerEvents>(
    event: K,
    ...args: Parameters<ClientToServerEvents[K]>
  ) {
    if (!this.wanted) return;
    fetch(`${RT}/emit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-matchup-sid': this.sid,
      },
      body: JSON.stringify({ event, payload: args[0] ?? null }),
      keepalive: true,
    }).catch(() => undefined);
  }

  connect() {
    if (this.wanted) return;
    this.wanted = true;
    void this.run(); // the retry loop never ends while `wanted` stays true
  }

  disconnect() {
    this.wanted = false;
    if (this.connected) {
      this.connected = false;
      this.dispatch('disconnect');
    }
  }

  private async run() {
    let delay = RETRY_MIN_MS;
    while (this.wanted) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
      try {
        const res = await fetch(
          `${RT}/poll?since=${this.cursor}&wait=${POLL_WAIT_SEC}`,
          { headers: { 'x-matchup-sid': this.sid }, signal: controller.signal },
        );
        if (!res.ok) throw new Error(`poll ${res.status}`);
        const data = (await res.json()) as {
          ok: boolean;
          events: { id: number; event: string; payload: unknown }[];
          cursor: number;
          presence: { online: number; looking: number } | null;
          waiting: WaitingStatus | null;
        };
        if (!data.ok) throw new Error('poll not ok');

        if (!this.connected) {
          this.connected = true;
          this.connectedAt = Date.now();
          delay = RETRY_MIN_MS;
          this.dispatch('connect');
        }

        for (const item of data.events || []) {
          this.cursor = Math.max(this.cursor, item.id || 0);
          this.dispatch(item.event, item.payload);
        }
        if (typeof data.cursor === 'number') {
          this.cursor = Math.max(this.cursor, data.cursor);
        }

        // Piggybacked state: dispatch only when it actually changed, so the
        // app's counters stay live without any server-side ticker.
        if (data.presence) {
          const key = JSON.stringify(data.presence);
          if (key !== this.lastPresence) {
            this.lastPresence = key;
            this.dispatch('presence', data.presence);
          }
        }
        if (data.waiting) {
          const key = JSON.stringify(data.waiting);
          if (key !== this.lastWaiting) {
            this.lastWaiting = key;
            this.dispatch('match:waiting', data.waiting);
          }
        } else if (this.lastWaiting) {
          this.lastWaiting = '';
        }
      } catch (err) {
        if (!this.wanted) break;
        if (this.connected) {
          this.connected = false;
          this.dispatch('disconnect');
        }
        this.dispatch('connect_error', err instanceof Error ? err : new Error(String(err)));
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

/**
 * Build the realtime connection. Retries forever at a capped 4s: a finite
 * count is how a visitor ends up stranded, and the API can briefly disappear
 * (a redeploy, a cold start) and always comes back.
 */
export function createSignalingSocket(): AppSocket {
  return new PollingSocket();
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
