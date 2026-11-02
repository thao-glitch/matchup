/**
 * Socket lifecycle for group rooms — the two flows that open a signaling
 * socket for exactly one short job and must never leave it behind.
 *
 * Both live here rather than inside the pages because both are easy to get
 * subtly wrong:
 *
 *   • `room:create` answers a validation failure with **two** `server:error`
 *     events on purpose (`server/src/rooms.js`): a generic code message
 *     first, the human one right behind it. Tearing the socket down on the
 *     first error discards exactly the message the form needs to show.
 *   • A reconnect hands the client a fresh socket id, and the server drops
 *     the old one from the roster the moment its transport dies — so a
 *     reconnected socket must re-enter the room, otherwise every later
 *     `room:signal` is relayed to participants who cannot see it.
 *   • Both callers unmount mid-handshake (React StrictMode mounts effects
 *     twice in dev), so nothing here may outlive the screen that asked.
 */
import type { Room, RoomPeer } from '../types/social';
import { getToken } from './auth';
import { createSignalingSocket, type AppSocket } from './signaling';

export interface CreateRoomInput {
  title: string;
  /** `0` is free; any other figure is clamped server-side to min/max. */
  price: number;
  isAdult: boolean;
  max: number;
  kind: 'group' | 'conference';
}

/** Hold the socket this long after an error so the second message lands. */
const ERROR_GRACE_MS = 250;
/** If the server never answers at all, fail the form instead of spinning. */
const ANSWER_TIMEOUT_MS = 12_000;

/**
 * Open a room and resolve with the row to navigate to.
 *
 * The socket is disconnected before the promise settles either way — a
 * creation attempt must not leak a connection when the form is abandoned.
 * Pass `signal` to cancel from a page unmount.
 */
export function createRoom(
  input: CreateRoomInput,
  opts: { signal?: AbortSignal } = {},
): Promise<Room> {
  const token = getToken();
  if (!token) return Promise.reject(new Error('Sign in to host a room.'));
  if (opts.signal?.aborted) return Promise.reject(new Error('Room creation was cancelled.'));

  return new Promise<Room>((resolve, reject) => {
    const socket = createSignalingSocket();
    const signal = opts.signal;
    let settled = false;
    let lastMessage: string | null = null;
    let errorTimer: number | null = null;

    function done(after: () => void): void {
      if (settled) return;
      settled = true;
      window.clearTimeout(watchdog);
      if (errorTimer !== null) window.clearTimeout(errorTimer);
      signal?.removeEventListener('abort', onAbort);
      after();
      // Leave last: the promise is already settled, so a lost final packet
      // can never hang the caller waiting on a dead transport.
      socket.disconnect();
    }

    function onAbort(): void {
      done(() => reject(new Error('Room creation was cancelled.')));
    }

    const watchdog = window.setTimeout(
      () =>
        done(() =>
          reject(new Error('The server did not answer — check your connection and try again.')),
        ),
      ANSWER_TIMEOUT_MS,
    );

    signal?.addEventListener('abort', onAbort);

    socket.on('room:created', ({ room }) => done(() => resolve(room)));
    socket.on('server:error', (info) => {
      lastMessage = info.message;
      // Grace, then reject with whichever message arrived last — for
      // validation failures that is the verbatim one worth showing.
      if (errorTimer !== null) window.clearTimeout(errorTimer);
      errorTimer = window.setTimeout(
        () => done(() => reject(new Error(lastMessage ?? 'That room could not be created.'))),
        ERROR_GRACE_MS,
      );
    });

    // The HTTP long-poll shim only sends once it is started; `emit` before
    // `connect()` is deliberately dropped. Start the loop, then ask.
    socket.connect();
    socket.emit('room:create', { token, ...input });
  });
}

export interface EnterRoomHandlers {
  onJoined: (msg: { room: Room; self: RoomPeer; peers: RoomPeer[] }) => void;
  onState: (msg: { slug: string; participants: RoomPeer[]; count: number }) => void;
  onSignal: (msg: {
    slug: string;
    from: number;
    username?: string;
    kind: 'offer' | 'answer' | 'candidate' | 'media';
    payload: unknown;
  }) => void;
  onClosed: (msg: { slug: string; byAdmin?: boolean }) => void;
  onError: (info: { code: string; message: string }) => void;
  /** Transport up/down — drives the "reconnecting" pill in the call header. */
  onConnectionChange?: (connected: boolean) => void;
}

/**
 * Connect and enter `slug`. The caller keeps the returned socket to relay
 * `room:signal`, leave and end the room, and disposes it in its own cleanup.
 *
 * `room:enter` is authenticated, so it is re-sent on every reconnect: the
 * token rides each attempt and the server re-checks entitlement from scratch.
 */
export function enterRoom(slug: string, handlers: EnterRoomHandlers): AppSocket {
  const socket = createSignalingSocket();

  function sendEnter(): void {
    const token = getToken();
    if (!token) {
      handlers.onError({ code: 'unauthorized', message: 'Sign in to join a room.' });
      return;
    }
    // Buffered by socket.io until the transport connects — the first flush is
    // what enters the room; later calls below are reconnect retries.
    socket.emit('room:enter', { token, slug });
  }

  let connects = 0;
  socket.on('connect', () => {
    connects += 1;
    // Only a *re*-connect re-enters: the server already dropped this account
    // from the roster when the transport went away.
    if (connects > 1) sendEnter();
    handlers.onConnectionChange?.(true);
  });
  socket.on('disconnect', () => handlers.onConnectionChange?.(false));
  socket.on('room:joined', handlers.onJoined);
  socket.on('room:state', handlers.onState);
  socket.on('room:signal', handlers.onSignal);
  socket.on('room:closed', handlers.onClosed);
  socket.on('server:error', handlers.onError);

  // Start the long-poll loop before the first emit. Without this the shim
  // drops `room:enter` and the room page spins forever.
  socket.connect();
  sendEnter();
  return socket;
}
