import { useCallback, useEffect, useRef, useState } from 'react';
import LobbyForm from './components/LobbyForm';
import WaitingScreen from './components/WaitingScreen';
import VideoChat from './components/VideoChat';
import PostCall from './components/PostCall';
import EuropeBoard from './components/EuropeBoard';
import LegalPage, { type LegalPageId } from './components/LegalPage';
import PassportOverlay from './components/PassportOverlay';
import { AlertIcon } from './components/icons';
import { MediaError, hasLiveMedia, acquireLocalMedia, stopStream } from './lib/media';
import { AuthError, loadAccount, saveAccountProfile } from './lib/auth';
import { DEFAULT_CONFIG, loadConfig, type PublicConfig } from './lib/config';
import { loadDraft, saveDraft } from './lib/draft';
import { addStamp, syncPassport, uniqueCountries } from './lib/passport';
import { createSignalingSocket, normalizeProfile, type AppSocket } from './lib/signaling';
import type {
  AccountUser,
  AppError,
  MatchInfo,
  Profile,
  ShareMeta,
  StampInfo,
  WaitingStatus,
} from './types';

/**
 * App is a four-phase state machine:
 *
 *   lobby ──start──▶ waiting ──match:found──▶ chat
 *     ▲                 ▲                        │
 *     │                 │       end / peer left  ▼
 *     └──── stop ───────┴────── next ──────── post-call
 *
 * A call NEVER re-queues itself: it always lands on the post-call screen and
 * the user chooses **Next** (queue again) or **Stop matching** (back to lobby).
 *
 * It owns: the signaling socket, the shared local MediaStream (reused across
 * matches so the camera is only ever requested once), the signed-in account
 * and the match lifecycle. All WebRTC work lives in <VideoChat />.
 */
type Phase = 'lobby' | 'waiting' | 'chat' | 'postcall';
type ServerStatus = 'ok' | 'retrying' | 'down';

/** Heading + one-liner for the post-call screen. */
interface PostCallInfo {
  title: string;
  detail: string;
}

export default function App() {
  const [phase, setPhase] = useState<Phase>('lobby');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [match, setMatch] = useState<MatchInfo | null>(null);
  const [presence, setPresence] = useState<WaitingStatus>({ looking: 0, online: 0 });
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverStatus, setServerStatus] = useState<ServerStatus>('ok');
  const [socket, setSocket] = useState<AppSocket | null>(null);
  const [postCall, setPostCall] = useState<PostCallInfo | null>(null);
  const [account, setAccount] = useState<AccountUser | null>(null);
  /** Last profile used — pre-fills the lobby form after a reload. */
  const [draft, setDraft] = useState<Profile | null>(() => loadDraft());
  /** What the finished call may be shared as — countries + seconds only. */
  const [shareMeta, setShareMeta] = useState<ShareMeta | null>(null);
  /** The live per-country board, opened from the lobby or via `#europe`. */
  const [boardOpen, setBoardOpen] = useState(false);
  /** Privacy / Terms overlays — linkable via `#privacy` / `#terms`. */
  const [legal, setLegal] = useState<LegalPageId | null>(null);
  /** The Passport book — linkable via `#passport`. */
  const [passportOpen, setPassportOpen] = useState(false);
  /** Distinct stamped countries — drives the lobby button's counter. */
  const [passportUnique, setPassportUnique] = useState(() => uniqueCountries());
  /** The stamp this finished call produced — celebrated on the post-call screen. */
  const [stamp, setStamp] = useState<StampInfo | null>(null);
  /** Live chemistry score of the ongoing call (null before the first one). */
  const [compat, setCompat] = useState<number | null>(null);
  /**
   * Server-side switches (ads / sign-ups / payments / maintenance) — fetched
   * once per page load from `/api/config` and edited in the `/admin` panel.
   * Starting from the defaults means an unreachable config can never stop the
   * lobby from rendering.
   */
  const [config, setConfig] = useState<PublicConfig>(DEFAULT_CONFIG);

  const socketRef = useRef<AppSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const profileRef = useRef<Profile | null>(null);
  const accountRef = useRef<AccountUser | null>(null);
  // Socket handlers are registered once, so they read the live phase through a
  // ref instead of capturing a stale closure.
  const phaseRef = useRef<Phase>('lobby');

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  /** Keep the ref current AND update state — every account change goes here. */
  const applyAccount = useCallback((user: AccountUser | null) => {
    accountRef.current = user;
    setAccount(user);
    if (user) {
      // Signed in → converge with the passport stored server-side: this
      // device adopts older stamps from other phones and uploads its own.
      void syncPassport().then(() => setPassportUnique(uniqueCountries()));
    }
  }, []);

  // ── Share-card bookkeeping (the "Share this connection" button) ────────────
  // Country codes plus a clock that only starts once media actually flows: a
  // call that fails to connect must never produce a card claiming otherwise.
  const shareRef = useRef<{ peerCountry: string; connectedAt: number; live: boolean } | null>(
    null,
  );

  /** Snapshot the finished call for the post-call screen — or clear it. */
  const captureShare = useCallback(() => {
    const s = shareRef.current;
    shareRef.current = null;
    if (!s || !s.live) {
      setShareMeta(null);
      setStamp(null);
      return;
    }
    const seconds = Math.max(1, Math.round((Date.now() - s.connectedAt) / 1000));
    // 🌍 The Passport: a conversation that actually connected stamps the
    // partner's country — collection is why people queue up one more time.
    const result = addStamp(s.peerCountry);
    setShareMeta({
      myCountry: profileRef.current?.country ?? '',
      peerCountry: s.peerCountry,
      seconds,
      passport: uniqueCountries(),
    });
    setStamp(result);
    if (result) setPassportUnique(result.unique);
  }, []);

  /** VideoChat reports the first `connected` — start the card's clock. */
  const handleCallConnected = useCallback(() => {
    const s = shareRef.current;
    if (s) {
      s.live = true;
      s.connectedAt = Date.now();
    }
  }, []);

  // Silent re-login: returning visitors land on a prefilled form.
  useEffect(() => {
    let cancelled = false;
    void loadAccount().then((user) => {
      if (!cancelled && user) applyAccount(user);
    });
    return () => {
      cancelled = true;
    };
  }, [applyAccount]);

  // Feature switches + the paybill block, once per page load. `loadConfig`
  // caches and never rejects, so this can neither hang nor throw.
  useEffect(() => {
    let cancelled = false;
    void loadConfig().then((cfg) => {
      if (!cancelled) setConfig(cfg);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Signaling lifecycle ────────────────────────────────────────────────────
  useEffect(() => {
    const s = createSignalingSocket();
    socketRef.current = s;
    setSocket(s);

    const onMatchFound = (m: MatchInfo) => {
      setMatch(m);
      setNotice(null);
      setCompat(null); // fresh call → fresh chemistry
      // Fresh call: the previous card (if any) is done, and this one starts
      // unproven — it only becomes shareable once media flows.
      setShareMeta(null);
      shareRef.current = { peerCountry: m.peer.country, connectedAt: 0, live: false };
      setPhase('chat');
    };

    const onWaiting = (status: WaitingStatus) => setPresence(status);
    const onPresence = (status: WaitingStatus) => setPresence(status);

    const onPeerLeft = () => {
      // Ignore stale notifications that arrive after we already hung up.
      if (phaseRef.current !== 'chat') return;
      // The partner hung up or dropped: release the room and stop on the
      // post-call screen. Nothing re-queues itself — the user decides.
      setMatch(null);
      setNotice(null);
      captureShare();
      setPostCall({
        title: 'Stranger disconnected',
        detail: 'Your partner left the call. Ready for someone new?',
      });
      setPhase('postcall');
    };

    const onServerError = (info: { code: string; message: string }) => {
      if (info.code === 'queue') {
        const err: AppError = {
          code: 'server',
          title: 'Matchmaking error',
          message: info.message,
        };
        setError(err);
        setPhase('lobby');
        return;
      }
      setNotice(info.message);
    };

    const onConnect = () => setServerStatus('ok');
    const onConnectError = () => setServerStatus((prev) => (prev === 'down' ? prev : 'retrying'));
    // Reconnection lifecycle events are emitted on the Manager, not the socket.
    const onReconnectFailed = () => setServerStatus('down');
    const onDisconnect = () => setServerStatus((prev) => (prev === 'down' ? prev : 'retrying'));

    s.on('match:found', onMatchFound);
    s.on('match:waiting', onWaiting);
    s.on('presence', onPresence);
    s.on('peer:left', onPeerLeft);
    s.on('server:error', onServerError);
    s.on('connect', onConnect);
    s.on('connect_error', onConnectError);
    s.on('disconnect', onDisconnect);
    s.io.on('reconnect_failed', onReconnectFailed);

    return () => {
      s.off('match:found', onMatchFound);
      s.off('match:waiting', onWaiting);
      s.off('presence', onPresence);
      s.off('peer:left', onPeerLeft);
      s.off('server:error', onServerError);
      s.off('connect', onConnect);
      s.off('connect_error', onConnectError);
      s.off('disconnect', onDisconnect);
      s.io.off('reconnect_failed', onReconnectFailed);
      s.emit('queue:leave');
      s.disconnect();
      socketRef.current = null;
      setSocket(null);
    };
  }, [captureShare]);

  // Release hardware when the tab goes away (the camera light must turn off).
  useEffect(() => {
    const onUnload = () => stopStream(streamRef.current);
    window.addEventListener('pagehide', onUnload);
    return () => {
      window.removeEventListener('pagehide', onUnload);
      stopStream(streamRef.current);
      streamRef.current = null;
    };
  }, []);

  // The board and the legal pages are linkable: load the page with `#europe`,
  // `#privacy` or `#terms` and they open themselves; Close strips the hash.
  useEffect(() => {
    const sync = () => {
      const hash = window.location.hash;
      setBoardOpen(hash === '#europe');
      setPassportOpen(hash === '#passport');
      setLegal(hash === '#privacy' ? 'privacy' : hash === '#terms' ? 'terms' : null);
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const stripHash = useCallback(() => {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);
  const openBoard = useCallback(() => setBoardOpen(true), []);
  const closeBoard = useCallback(() => {
    setBoardOpen(false);
    if (window.location.hash === '#europe') stripHash();
  }, [stripHash]);
  const closeLegal = useCallback(() => {
    setLegal(null);
    const hash = window.location.hash;
    if (hash === '#privacy' || hash === '#terms') stripHash();
  }, [stripHash]);
  const openPassport = useCallback(() => setPassportOpen(true), []);
  const closePassport = useCallback(() => {
    setPassportOpen(false);
    if (window.location.hash === '#passport') stripHash();
  }, [stripHash]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const start = useCallback(
    async (profile: Profile) => {
      setBusy(true);
      setError(null);
      try {
        // Acquire media *before* entering the queue: there is no point matching
        // someone who is about to fail a permission prompt.
        if (!hasLiveMedia(streamRef.current)) {
          const stream = await acquireLocalMedia();
          streamRef.current = stream;
          setLocalStream(stream);
        }

        profileRef.current = profile;
        // Remember the details for next time — device-local for everyone, and
        // mirrored onto the account below when signed in.
        setDraft(profile);
        saveDraft(profile);
        setNotice(null);
        setPostCall(null);
        setShareMeta(null);

        // Profile + preferences are freely editable, so every start persists
        // whatever the form currently says (fire-and-forget: a failed sync must
        // never block matchmaking).
        const user = accountRef.current;
        if (user) {
          void saveAccountProfile(profile)
            .then((saved) => applyAccount(saved))
            .catch((err: unknown) => {
              if (err instanceof AuthError && err.code === 'unauthorized') {
                applyAccount(null);
                setNotice('Your session expired — sign in again to keep your details.');
              } else {
                setNotice('Your details still apply, but they could not be saved to your account.');
              }
            });
        }

        // Socket.io buffers this if the connection is still being (re)established.
        socketRef.current?.emit('queue:join', normalizeProfile(profile));
        setPhase('waiting');
      } catch (err) {
        setError(
          err instanceof MediaError
            ? err.appError
            : {
                code: 'server',
                title: 'Unable to start',
                message: err instanceof Error ? err.message : 'Unexpected error.',
              },
        );
      } finally {
        setBusy(false);
      }
    },
    [applyAccount],
  );

  /** You hung up: stop on the post-call screen and let the user decide. */
  const endCall = useCallback(() => {
    socketRef.current?.emit('call:end');
    setMatch(null);
    setNotice(null);
    captureShare();
    setPostCall({ title: 'Call ended', detail: 'You left the conversation. What next?' });
    setPhase('postcall');
  }, [captureShare]);

  /**
   * "Next" — back into the queue for a different stranger. Also used by the
   * failure screen's "Find someone else", where the room is still open.
   */
  const nextMatch = useCallback(() => {
    const s = socketRef.current;
    const p = profileRef.current;
    if (!s || !p) {
      setPhase('lobby');
      return;
    }
    // `call:end` is a no-op when the room is already gone (partner hung up),
    // but from "Unable to connect" we are still attached — and the server
    // ignores `queue:join` while a room exists, so it has to go first.
    s.emit('call:end');
    s.emit('queue:join', normalizeProfile(p));
    setMatch(null);
    setNotice(null);
    setPostCall(null);
    setShareMeta(null);
    setPhase('waiting');
  }, []);

  /** Stop matching: leave the queue, release the camera, back to the lobby. */
  const leave = useCallback(() => {
    const s = socketRef.current;
    s?.emit('call:end');
    s?.emit('queue:leave');
    stopStream(streamRef.current);
    streamRef.current = null;
    setLocalStream(null);
    setMatch(null);
    profileRef.current = null;
    setNotice(null);
    setPostCall(null);
    setShareMeta(null);
    setError(null);
    setPhase('lobby');
  }, []);

  const retryServer = useCallback(() => {
    setServerStatus('retrying');
    const s = socketRef.current;
    if (s && !s.connected) s.connect();
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────
  const serverDown = serverStatus === 'down';
  const showBanner = serverStatus !== 'ok' && phase !== 'lobby' && !serverDown;

  return (
    <div
      className={`app-bg relative flex w-full flex-col ${
        phase === 'chat' ? 'h-full overflow-hidden' : 'min-h-full'
      }`}
    >
      {phase === 'lobby' && (
        <LobbyForm
          account={account}
          draft={draft}
          onStart={start}
          onAccountChange={applyAccount}
          onOpenBoard={openBoard}
          passportUnique={passportUnique}
          onOpenPassport={openPassport}
          busy={busy}
          error={error}
          config={config}
        />
      )}

      {phase === 'waiting' && (
        <WaitingScreen
          localStream={localStream}
          presence={presence}
          onCancel={leave}
          notice={notice}
        />
      )}

      {phase === 'chat' && match && localStream && socket && (
        <VideoChat
          match={match}
          localStream={localStream}
          socket={socket}
          onEndCall={endCall}
          onNext={nextMatch}
          onConnected={handleCallConnected}
          onChemistry={setCompat}
        />
      )}

      {phase === 'postcall' && postCall && (
        <PostCall
          title={postCall.title}
          detail={postCall.detail}
          onNext={nextMatch}
          onStop={leave}
          share={shareMeta}
          stamp={stamp}
          compat={compat}
        />
      )}

      {boardOpen && <EuropeBoard onClose={closeBoard} />}
      {passportOpen && <PassportOverlay onClose={closePassport} />}
      {legal && <LegalPage page={legal} onClose={closeLegal} />}

      {/* The dashboard's kill switch: matchmaking is paused, everything else
          (reading, signing in, checking a payment) keeps working. */}
      {config.features.maintenance && (
        <div className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 bg-warn/15 px-4 py-2 text-xs font-medium text-warn backdrop-blur">
          <AlertIcon className="h-4 w-4" />
          Matchmaking is paused for maintenance — check back in a few minutes.
        </div>
      )}

      {showBanner && (
        <div className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 bg-warn/15 px-4 py-2 text-xs font-medium text-warn backdrop-blur">
          <AlertIcon className="h-4 w-4" />
          Signaling connection lost — retrying…
        </div>
      )}

      {serverDown && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface/90 px-6 backdrop-blur">
          <div className="card max-w-md p-7 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-danger/15 text-danger">
              <AlertIcon className="h-6 w-6" />
            </div>
            <h2 className="text-lg font-semibold text-ink">Unable to connect to the server</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              The matchmaking server is unreachable — this can be a maintenance window, a
              blocked WebSocket, or a network that only allows HTTPS on port 443.
            </p>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
              <button type="button" onClick={retryServer} className="btn btn-primary">
                Retry
              </button>
              <button type="button" onClick={leave} className="btn btn-ghost">
                Back to start
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
