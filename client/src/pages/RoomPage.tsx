/**
 * RoomPage — a paid group call or an 18+ conference, full bleed (Shell hides
 * the tab bar for this route: navigation chrome over a live call is worse
 * than useless).
 *
 * Three lifecycles die together on unmount — the camera, one `Peer` per
 * remote account (WebRTC mesh, no media server) and the signaling socket —
 * so one effect owns all three and its cleanup is idempotent. React
 * StrictMode runs setup → teardown → setup in dev, and a setup that was
 * still waiting on `getUserMedia` when the teardown arrived must stop its
 * own stream instead of leaking it (the `disposed` flag).
 *
 * Mesh rule from docs/PLATFORM.md: the side with the HIGHER account id dials
 * (`initiator = self.id > other.id`), computed identically on both sides, so
 * exactly one offer exists per pair and `Peer`'s perfect negotiation covers
 * glare. `room:state` is the roster the mesh syncs to; `room:signal` can
 * arrive first, in which case the peer for that sender is created on the spot.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PageProps } from '../shell/pageProps';
import type { AppError, CallState } from '../types';
import type { RoomAccess, RoomPeer } from '../types/social';
import { getToken } from '../lib/auth';
import { getIceConfig } from '../lib/iceServers';
import { MediaError, acquireLocalMedia, stopStream } from '../lib/media';
import { Peer } from '../lib/peer';
import { enterRoom } from '../lib/rooms';
import { navigate } from '../lib/router';
import { SocialError, formatKes, getRoom } from '../lib/social';
import type { AppSocket } from '../lib/signaling';
import PaySheet from '../components/PaySheet';
import {
  AlertIcon,
  ArrowLeftIcon,
  CamIcon,
  CamOffIcon,
  FlameIcon,
  LockIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  SpinnerIcon,
  UsersIcon,
} from '../components/icons';

type Failure = { code: string; message: string };

/** Codes `room:enter` / `room:create` can answer with, each with its own card. */
const KNOWN_FAILURES = new Set([
  'payment-required',
  'adult-only',
  'room-full',
  'room-ended',
  'unauthorized',
  'not-found',
  'groups-disabled',
]);

/** Leftover reason codes have no message of their own — say them in words. */
const REASON_TEXT: Record<string, string> = {
  'groups-disabled': 'Group calls are switched off right now.',
};

const STATE_META: Record<CallState, { label: string; className: string }> = {
  connecting: { label: 'Connecting', className: 'border-warn/40 bg-warn/15 text-warn' },
  connected: { label: 'Connected', className: 'border-ok/40 bg-ok/15 text-ok' },
  reconnecting: { label: 'Reconnecting…', className: 'border-warn/40 bg-warn/15 text-warn' },
  failed: { label: 'Unable to connect', className: 'border-danger/40 bg-danger/15 text-danger' },
  closed: { label: 'Call ended', className: 'border-white/15 bg-white/10 text-muted' },
};

export default function RoomPage({
  account,
  config,
  params,
  requireAuth,
  adultOk,
  acknowledgeAdult,
}: PageProps) {
  const slug = params.slug ?? '';

  // ── Access over HTTP (entitlement, age, capacity) ────────────────────────
  const [reloadKey, setReloadKey] = useState(0);
  const [access, setAccess] = useState<RoomAccess | null>(null);
  const [accessError, setAccessError] = useState<Failure | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = () => setReloadKey((n) => n + 1);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    getRoom(slug)
      .then((res) => {
        if (disposed) return;
        setAccess(res);
        setAccessError(null);
      })
      .catch((err: unknown) => {
        if (disposed) return;
        setAccess(null);
        setAccessError({
          code: err instanceof SocialError ? err.code : 'unknown',
          message: err instanceof Error ? err.message : 'That room could not be opened.',
        });
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [slug, reloadKey]);

  // ── Call state ───────────────────────────────────────────────────────────
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [mediaError, setMediaError] = useState<AppError | null>(null);
  const [participants, setParticipants] = useState<RoomPeer[]>([]);
  const [selfId, setSelfId] = useState<number | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<ReadonlyMap<number, MediaStream>>(new Map());
  const [peerStates, setPeerStates] = useState<ReadonlyMap<number, CallState>>(new Map());
  const [socketError, setSocketError] = useState<Failure | null>(null);
  const [closed, setClosed] = useState(false);
  const [closedByAdmin, setClosedByAdmin] = useState(false);
  const [joining, setJoining] = useState(false);
  const [signalingUp, setSignalingUp] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  /** Bumped by "try again" and by a successful payment: restarts the call. */
  const [attempt, setAttempt] = useState(0);

  const peersRef = useRef<Map<number, Peer>>(new Map());
  const socketRef = useRef<AppSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const selfRef = useRef<number | null>(null);

  const room = access?.room ?? null;
  const entitled = Boolean(access?.canEnter);
  const roomIsAdult = Boolean(room?.isAdult);
  const underAge = Boolean(account && Number(account.profile?.age) < 18);
  /** A stored token means the silent re-login is still in flight — wait. */
  const authPending = !account && Boolean(getToken());
  const accountKey = account ? `${account.id ?? ''}:${account.username}` : '';
  const isHost = Boolean(account && room && account.id === room.hostId);

  // ── The call: media + signaling + mesh, one effect, one teardown ─────────
  useEffect(() => {
    if (!entitled || !account) return;
    // The acknowledgement card owns this screen until the device is cleared.
    if (roomIsAdult && !adultOk) return;

    let disposed = false;
    let dead = false;
    let socket: AppSocket | null = null;
    let stream: MediaStream | null = null;
    let iceServers: RTCIceServer[] = [];
    const peers = peersRef.current;

    setJoining(true);
    setSignalingUp(true);
    setSocketError(null);
    setClosed(false);
    setClosedByAdmin(false);
    // Fresh tracks always start enabled — the toggles follow the hardware,
    // not a flag left over from the previous attempt.
    setMicOn(true);
    setCamOn(true);

    /** Drop one mesh leg: participant left, error, or teardown. */
    function dropPeer(id: number): void {
      const existing = peers.get(id);
      if (existing) {
        peers.delete(id);
        existing.destroy();
      }
      setPeerStates((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      setRemoteStreams((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    }

    /**
     * One RTCPeerConnection per remote account — the mesh. `initiator` is the
     * server-independent rule both sides compute: the higher account id dials.
     * Signals can arrive before `room:state`, so this also serves as the
     * get-or-create path for a sender we have not been told about yet.
     */
    function ensurePeer(remoteId: number): Peer | null {
      const from = selfRef.current;
      const link = socket;
      const media = stream;
      if (from === null || !link || !media) return null;
      const existing = peers.get(remoteId);
      if (existing) return existing;

      const peer = new Peer({
        initiator: from > remoteId,
        localStream: media,
        iceServers,
        send: (msg) => link.emit('room:signal', { slug, to: remoteId, ...msg }),
        onState: (state) => {
          if (disposed) return;
          setPeerStates((prev) => new Map(prev).set(remoteId, state));
        },
        onRemoteStream: (remote) => {
          if (disposed) return;
          setRemoteStreams((prev) => new Map(prev).set(remoteId, remote));
        },
      });
      peers.set(remoteId, peer);
      if (!disposed) setPeerStates((prev) => new Map(prev).set(remoteId, 'connecting'));
      return peer;
    }

    /** Reconcile the mesh against a roster: dial the missing, drop the gone. */
    function syncRoster(roster: RoomPeer[]): void {
      const from = selfRef.current;
      if (from === null) return;
      const wanted = new Set<number>();
      for (const person of roster) {
        if (person.id === from) continue;
        wanted.add(person.id);
        ensurePeer(person.id);
      }
      for (const id of [...peers.keys()]) {
        if (!wanted.has(id)) dropPeer(id);
      }
    }

    /**
     * Release everything this run owns. Safe to call twice (error screen now,
     * unmount later) and safe to call when only half of it was acquired —
     * that is what makes StrictMode's double mount survivable.
     */
    function teardown(leave: boolean): void {
      dead = true;
      if (socket) {
        if (leave) socket.emit('room:leave', { slug });
        socket.removeAllListeners();
        socket.disconnect();
        socket = null;
      }
      socketRef.current = null;
      for (const id of [...peers.keys()]) dropPeer(id);
      if (stream) {
        stopStream(stream);
        stream = null;
        streamRef.current = null;
        setLocalStream(null);
      }
    }

    function handleJoined(msg: { self: RoomPeer; peers: RoomPeer[] }): void {
      if (disposed) return;
      selfRef.current = msg.self.id;
      setSelfId(msg.self.id);
      const roster = [msg.self, ...msg.peers];
      syncRoster(roster);
      setParticipants(roster);
      setJoining(false);
    }

    function handleState(msg: { participants: RoomPeer[] }): void {
      if (disposed) return;
      syncRoster(msg.participants);
      setParticipants(msg.participants);
    }

    function handleSignal(msg: {
      from: number;
      kind: 'offer' | 'answer' | 'candidate';
      payload: unknown;
    }): void {
      if (disposed) return;
      const peer = ensurePeer(msg.from);
      if (!peer) return;
      // The wire type is `unknown` because SDP and ICE differ: cast by kind,
      // exactly the split `Peer.handleSignal` performs internally.
      const payload =
        msg.kind === 'candidate'
          ? (msg.payload as RTCIceCandidateInit)
          : (msg.payload as RTCSessionDescriptionInit);
      void peer.handleSignal({ kind: msg.kind, payload });
    }

    function handleClosed(msg: { byAdmin?: boolean }): void {
      if (disposed) return;
      teardown(false); // the camera must not keep running behind the screen
      setClosedByAdmin(Boolean(msg.byAdmin));
      setClosed(true);
      setJoining(false);
    }

    function handleError(info: Failure): void {
      if (disposed) return;
      teardown(false);
      setSocketError(info);
      setJoining(false);
    }

    (async () => {
      // Credentials come cached and never throw; media is the fallible part.
      const ice = await getIceConfig();
      iceServers = ice.iceServers;

      let media: MediaStream;
      try {
        media = await acquireLocalMedia();
      } catch (err) {
        if (disposed) return;
        setMediaError(
          err instanceof MediaError
            ? err.appError
            : {
                code: 'media-missing',
                title: 'Unable to start camera',
                message:
                  err instanceof Error && err.message
                    ? err.message
                    : 'Something went wrong while starting your camera.',
              },
        );
        setJoining(false);
        return;
      }

      // Teardown arrived while the permission prompt was open: give it back.
      if (disposed) {
        stopStream(media);
        return;
      }

      stream = media;
      streamRef.current = media;
      setLocalStream(media);

      socket = enterRoom(slug, {
        onJoined: handleJoined,
        onState: handleState,
        onSignal: handleSignal,
        onClosed: handleClosed,
        onError: handleError,
        onConnectionChange: (up) => {
          if (!disposed) setSignalingUp(up);
        },
      });
      socketRef.current = socket;

      // `room:enter` can be refused synchronously (no token on the device),
      // which tears down before the assignment above lands — the socket that
      // came back would then sit connected and unreachable. Drop it here.
      if (dead) {
        socket.removeAllListeners();
        socket.disconnect();
        socket = null;
        socketRef.current = null;
      }
    })();

    return () => {
      disposed = true;
      teardown(true);
      selfRef.current = null;
      // Reset display state so a re-run (StrictMode, a new attempt) starts clean.
      setParticipants([]);
      setSelfId(null);
      setPeerStates(new Map());
      setRemoteStreams(new Map());
      setJoining(false);
    };
  }, [slug, entitled, accountKey, adultOk, roomIsAdult, attempt]);

  // ── Controls ─────────────────────────────────────────────────────────────

  /** Leave + navigate: the cleanup below finishes the teardown on unmount. */
  function leaveRoom(): void {
    socketRef.current?.emit('room:leave', { slug });
    navigate('/live');
  }

  function toggleMic(): void {
    const track = localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
  }

  function toggleCam(): void {
    const track = localStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCamOn(track.enabled);
  }

  function endRoom(): void {
    const token = getToken();
    if (!token || !socketRef.current) return;
    // The server answers every participant (us included) with `room:closed`.
    socketRef.current.emit('room:end', { token, slug });
    setConfirmEnd(false);
  }

  function retryMedia(): void {
    setMediaError(null);
    setAttempt((n) => n + 1);
  }

  /**
   * A retry from a failure card: refetch access *and* restart the call, since
   * the entitlement answer may not have changed (a late `payment-required`
   * arrives while `canEnter` already reads true, so the effect needs a bump).
   */
  function reloadAndRetry(): void {
    reload();
    setAttempt((n) => n + 1);
  }

  function paid(): void {
    setPayOpen(false);
    reloadAndRetry();
  }

  function acknowledge(): void {
    acknowledgeAdult();
    reload();
  }

  // ── Pre-call screens ─────────────────────────────────────────────────────

  function adultScreen(message?: string): ReactNode {
    // Signed out, the acknowledgement would change nothing — signing in is
    // what actually decides the age rule server-side.
    if (!account) return signInScreen();
    if (underAge) {
      return (
        <Screen>
          <CardHeading tone="warn" title="18+ room" />
          <p className="mt-2 text-sm leading-relaxed text-muted">
            {message ?? 'This room is 18+ — it is for accounts aged 18 and over.'}
          </p>
          <BackButton />
        </Screen>
      );
    }
    if (!adultOk) {
      return (
        <Screen>
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warn/15 text-warn">
              <AlertIcon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink">
                Adults only — sensitive content
              </h2>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">
                This room is 18+. Confirm that you are 18 or over to continue; the
                acknowledgement is remembered on this device only. You can leave at any time.
              </p>
            </div>
          </div>
          <button type="button" className="btn btn-primary mt-5 w-full" onClick={acknowledge}>
            I'm 18 or over
          </button>
          <BackButton />
        </Screen>
      );
    }
    // Acknowledged and the server still refuses — show its words verbatim.
    return (
      <Screen>
        <CardHeading tone="warn" title="18+ room" />
        <p className="mt-2 text-sm leading-relaxed text-muted">
          {message ?? 'This room cannot be opened right now.'}
        </p>
        <BackButton />
      </Screen>
    );
  }

  function signInScreen(): ReactNode {
    return (
      <Screen>
        <CardHeading tone="accent" title="Sign in to join" />
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Rooms are tied to an account — it is how entry fees reach the host and how you appear
          in the room.
        </p>
        <button
          type="button"
          className="btn btn-primary mt-5 w-full"
          onClick={() => requireAuth('Sign in to join this room.')}
        >
          Sign in / create account
        </button>
        <BackButton />
      </Screen>
    );
  }

  function messageScreen(title: string, message: string, retry = false): ReactNode {
    return (
      <Screen>
        <CardHeading tone="danger" title={title} />
        <p className="mt-2 text-sm leading-relaxed text-muted">{message}</p>
        <div className="mt-5 flex gap-2">
          {retry && (
            <button type="button" className="btn btn-primary flex-1" onClick={reloadAndRetry}>
              Try again
            </button>
          )}
          <button
            type="button"
            className={retry ? 'btn btn-ghost' : 'btn btn-primary w-full'}
            onClick={() => navigate('/live')}
          >
            Back to Live
          </button>
        </div>
      </Screen>
    );
  }

  function payScreen(): ReactNode {
    if (!room) return messageScreen('Room unavailable', 'That room could not be opened.');
    return (
      <Screen>
        <p className="text-xs uppercase tracking-wide text-muted">Paid room</p>
        <h2 className="mt-1 text-base font-semibold leading-snug text-ink">{room.title}</h2>
        <p className="mt-0.5 text-xs text-muted">Hosted by @{room.hostName}</p>

        <div className="mt-4 flex items-baseline justify-between rounded-xl border border-white/10 bg-surface-3/60 px-4 py-3">
          <span className="text-sm text-muted">Entry fee</span>
          <span className="text-xl font-bold text-ink">{formatKes(room.price)}</span>
        </div>

        <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-muted">
          <LockIcon className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <span>
            You pay the full {formatKes(room.price)} — the platform's{' '}
            {config.commerce.commissionRate}% fee is deducted from what @{room.hostName}{' '}
            receives.
          </span>
        </p>

        <button
          type="button"
          className="btn btn-primary mt-4 w-full"
          onClick={() => setPayOpen(true)}
        >
          Pay {formatKes(room.price)} to join
        </button>
        <BackButton />
        {payOpen && (
          <PaySheet
            target={{
              purpose: 'room',
              refId: room.id,
              amount: room.price,
              currency: room.currency,
              title: room.title,
            }}
            config={config}
            account={account}
            onRequireAuth={() => requireAuth('Sign in to pay for this room.')}
            onPaid={paid}
            onClose={() => setPayOpen(false)}
          />
        )}
      </Screen>
    );
  }

  if (loading) {
    return (
      <Screen>
        <div className="flex items-center gap-3 text-sm text-muted">
          <SpinnerIcon className="h-5 w-5 text-accent" />
          Opening the room…
        </div>
      </Screen>
    );
  }

  if (accessError) {
    if (accessError.code === 'adult-only') return adultScreen(accessError.message);
    if (accessError.code === 'not-found') {
      return messageScreen('Room not found', accessError.message, true);
    }
    return messageScreen('Room unavailable', accessError.message, true);
  }

  if (!access || !room) {
    return messageScreen('Room unavailable', 'That room could not be opened.', true);
  }

  // The age gate sits ahead of the camera: nothing is acquired until cleared.
  if (roomIsAdult && !adultOk) return adultScreen();

  if (!account) {
    if (authPending) {
      return (
        <Screen>
          <div className="flex items-center gap-3 text-sm text-muted">
            <SpinnerIcon className="h-5 w-5 text-accent" />
            Restoring your session…
          </div>
        </Screen>
      );
    }
    return signInScreen();
  }

  if (!access.canEnter) {
    const reason = access.reason;
    if (reason === 'payment-required') return payScreen();
    if (reason === 'unauthorized') return signInScreen();
    if (reason === 'adult-only') return adultScreen();
    if (reason === 'room-full') return messageScreen('Room full', 'That room is full — try the next one.');
    if (reason === 'room-ended') return messageScreen('Room ended', 'That room has ended.');
    return messageScreen(
      'Room unavailable',
      (reason && REASON_TEXT[reason]) || 'This room cannot be opened right now.',
    );
  }

  // ── In the call ──────────────────────────────────────────────────────────

  if (mediaError) {
    return (
      <Screen>
        <CardHeading tone="danger" title={mediaError.title} />
        <p className="mt-2 text-sm leading-relaxed text-muted">{mediaError.message}</p>
        <div className="mt-5 flex gap-2">
          <button type="button" className="btn btn-primary flex-1" onClick={retryMedia}>
            Try again
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => navigate('/live')}>
            Back to Live
          </button>
        </div>
      </Screen>
    );
  }

  if (socketError) {
    if (KNOWN_FAILURES.has(socketError.code)) {
      if (socketError.code === 'payment-required') return payScreen();
      if (socketError.code === 'adult-only') return adultScreen(socketError.message);
      if (socketError.code === 'unauthorized') return signInScreen();
      if (socketError.code === 'room-full') {
        return messageScreen('Room full', socketError.message);
      }
      if (socketError.code === 'room-ended' || socketError.code === 'not-found') {
        return messageScreen(
          socketError.code === 'not-found' ? 'Room not found' : 'Room ended',
          socketError.message,
        );
      }
      return messageScreen('Room unavailable', socketError.message);
    }
    return messageScreen('Something went wrong', socketError.message, true);
  }

  if (closed) {
    return (
      <Screen>
        <CardHeading
          tone="danger"
          title={closedByAdmin ? 'The room was closed' : 'The host ended the room'}
        />
        <p className="mt-2 text-sm leading-relaxed text-muted">
          {closedByAdmin
            ? 'The platform closed this room for everyone in it.'
            : '@' + room.hostName + ' ended the call. Pick another room or start your own.'}
        </p>
        <BackButton />
      </Screen>
    );
  }

  if (!selfId) {
    return (
      <Screen>
        <div className="flex items-center gap-3 text-sm text-muted">
          <SpinnerIcon className="h-5 w-5 text-accent" />
          {!signalingUp
            ? 'Reconnecting to the server…'
            : joining
              ? 'Joining the room…'
              : 'Connecting…'}
        </div>
        <BackButton />
      </Screen>
    );
  }

  const remotes = participants.filter((person) => person.id !== selfId);

  return (
    <div className="relative z-10 flex min-h-[100dvh] w-full flex-col">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-white/10 bg-surface/90 px-3 py-2.5 backdrop-blur sm:px-4">
        <button
          type="button"
          onClick={leaveRoom}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-2.5 py-2 text-xs font-semibold text-muted transition-colors hover:text-ink"
        >
          <ArrowLeftIcon className="h-4 w-4" />
          Back
        </button>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink">{room.title}</p>
          <p className="truncate text-xs text-muted">
            @{room.hostName}
            <span className="tabular-nums"> · {participants.length}</span>/
            {room.maxParticipants} in
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {!signalingUp && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-warn/40 bg-warn/15 px-2.5 py-1 text-[11px] font-semibold text-warn">
              <SpinnerIcon className="h-3 w-3" />
              Reconnecting
            </span>
          )}
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
              room.price > 0
                ? 'border-ok/40 bg-ok/10 text-ok'
                : 'border-white/15 bg-white/5 text-muted'
            }`}
          >
            {room.price > 0 && <LockIcon className="h-3.5 w-3.5" />}
            {room.price > 0 ? formatKes(room.price) : 'Free'}
          </span>
          {room.isAdult && (
            <span className="inline-flex items-center gap-1 rounded-full border border-danger/40 bg-danger/10 px-2.5 py-1 text-[11px] font-semibold text-danger">
              <FlameIcon className="h-3.5 w-3.5" />
              18+
            </span>
          )}
        </div>
      </header>

      {/* ── Stage ────────────────────────────────────────────────────────── */}
      <main className="min-h-0 flex-1 p-3 sm:p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <VideoTile
            label="You"
            stream={camOn ? localStream : null}
            mirrored
            muted
            placeholder={camOn ? 'Starting camera…' : 'Camera off'}
            badge={
              !micOn ? (
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-danger/85 text-white">
                  <MicOffIcon className="h-3.5 w-3.5" />
                </span>
              ) : null
            }
          />

          {remotes.map((person) => (
            <VideoTile
              key={person.id}
              label={person.username}
              stream={remoteStreams.get(person.id) ?? null}
              state={peerStates.get(person.id) ?? 'connecting'}
              placeholder={
                <span className="flex flex-col items-center gap-2 text-xs">
                  <SpinnerIcon className="h-5 w-5 text-accent" />
                  Connecting to {person.username}…
                </span>
              }
            />
          ))}

          {remotes.length === 0 && (
            <div className="card flex min-h-36 flex-col items-center justify-center gap-2 border-dashed p-6 text-center">
              <UsersIcon className="h-6 w-6 text-muted" />
              <p className="text-sm text-muted">Waiting for others…</p>
              <p className="text-xs text-muted/70">
                Share this room and the grid fills up as people join.
              </p>
            </div>
          )}
        </div>
      </main>

      {/* ── Dock ─────────────────────────────────────────────────────────── */}
      <footer className="sticky bottom-0 z-20 flex flex-wrap items-center justify-center gap-2 border-t border-white/10 bg-surface/90 px-3 py-3 backdrop-blur sm:gap-4">
        <DockButton
          label={micOn ? 'Mute microphone' : 'Unmute microphone'}
          caption="Mic"
          active={micOn}
          danger={!micOn}
          ariaPressed={micOn}
          onClick={toggleMic}
        >
          {micOn ? <MicIcon className="h-5 w-5" /> : <MicOffIcon className="h-5 w-5" />}
        </DockButton>

        <DockButton
          label={camOn ? 'Stop camera' : 'Start camera'}
          caption="Cam"
          active={camOn}
          danger={!camOn}
          ariaPressed={camOn}
          onClick={toggleCam}
        >
          {camOn ? <CamIcon className="h-5 w-5" /> : <CamOffIcon className="h-5 w-5" />}
        </DockButton>

        <button
          type="button"
          onClick={leaveRoom}
          title="Leave the room"
          aria-label="Leave the room"
          className="btn btn-danger h-12 w-12 rounded-full p-0 sm:h-12 sm:w-auto sm:px-6"
        >
          <PhoneOffIcon className="h-5 w-5" />
          <span className="hidden sm:inline">Leave</span>
        </button>

        {isHost && (
          <button
            type="button"
            onClick={() => setConfirmEnd(true)}
            title="End the room for everyone"
            aria-label="End the room for everyone"
            className="btn btn-ghost h-12 w-12 rounded-full p-0 sm:h-12 sm:w-auto sm:px-6"
          >
            <AlertIcon className="h-5 w-5 text-danger" />
            <span className="hidden sm:inline">End room</span>
          </button>
        )}
      </footer>

      {/* ── Host confirm step ────────────────────────────────────────────── */}
      {confirmEnd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="card w-full max-w-sm p-5">
            <h2 className="text-base font-semibold text-ink">End this room for everyone?</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Every participant is disconnected and the room closes — it cannot be reopened.
            </p>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                className="btn btn-ghost flex-1"
                onClick={() => setConfirmEnd(false)}
              >
                Keep it open
              </button>
              <button type="button" className="btn btn-danger flex-1" onClick={endRoom}>
                End room
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Local building blocks ────────────────────────────────────────────────────

/** Centred shell for every pre-call screen — this route is full bleed. */
function Screen({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center px-4 py-8">
      <div className="card w-full max-w-md p-6">{children}</div>
    </div>
  );
}

function CardHeading({ tone, title }: { tone: 'warn' | 'danger' | 'accent'; title: string }) {
  const tones = {
    warn: 'bg-warn/15 text-warn',
    danger: 'bg-danger/15 text-danger',
    accent: 'bg-accent/15 text-accent',
  } as const;
  return (
    <div className="flex items-start gap-3">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${tones[tone]}`}>
        <AlertIcon className="h-5 w-5" />
      </span>
      <h2 className="mt-2 text-base font-semibold text-ink">{title}</h2>
    </div>
  );
}

function BackButton() {
  return (
    <button
      type="button"
      className="btn btn-ghost mt-3 w-full"
      onClick={() => navigate('/live')}
    >
      <ArrowLeftIcon className="h-4 w-4" />
      Back to Live
    </button>
  );
}

interface VideoTileProps {
  label: string;
  stream: MediaStream | null;
  placeholder: ReactNode;
  mirrored?: boolean;
  muted?: boolean;
  /** Per-peer connection state — omitted on the local tile. */
  state?: CallState;
  badge?: ReactNode;
}

/**
 * One video cell. `srcObject` is assigned through a ref because React does
 * not treat it as an attribute — and it is cleared whenever the stream goes
 * away so a recycled tile never keeps another participant's frames.
 */
function VideoTile({ label, stream, placeholder, mirrored, muted, state, badge }: VideoTileProps) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    return () => {
      if (el) el.srcObject = null;
    };
  }, [stream]);

  const meta = state ? STATE_META[state] : null;

  return (
    <div className="card relative aspect-video min-h-40 overflow-hidden bg-black/60 p-0">
      {stream ? (
        <video
          ref={ref}
          autoPlay
          playsInline
          muted={muted}
          className={`h-full w-full object-cover ${mirrored ? 'scale-x-[-1]' : ''}`}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center px-4 text-center text-sm text-muted">
          {placeholder}
        </div>
      )}

      {badge && <div className="absolute left-2 top-2">{badge}</div>}

      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-2.5 pb-2 pt-6">
        <span className="truncate text-xs font-semibold text-ink">{label}</span>
        {meta && (
          <span
            className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${meta.className}`}
          >
            {meta.label}
          </span>
        )}
      </div>
    </div>
  );
}

function DockButton({
  label,
  caption,
  onClick,
  active,
  danger,
  ariaPressed,
  children,
}: {
  label: string;
  caption: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  ariaPressed?: boolean;
  children: ReactNode;
}) {
  const circle = danger
    ? 'border-danger/40 bg-danger/15 text-danger hover:bg-danger/25'
    : active
      ? 'border-accent/50 bg-accent/15 text-accent'
      : 'border-white/10 bg-white/5 text-ink hover:bg-white/10';
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={ariaPressed}
      className="group flex w-14 flex-col items-center gap-1 focus-visible:outline-none"
    >
      <span
        className={`flex h-11 w-11 items-center justify-center rounded-full border transition-colors ${circle}`}
      >
        {children}
      </span>
      <span className="text-[10px] font-medium text-muted group-hover:text-ink">{caption}</span>
    </button>
  );
}
