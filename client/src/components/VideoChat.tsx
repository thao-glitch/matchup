import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppSocket } from '../lib/signaling';
import { Peer } from '../lib/peer';
import { getIceConfig } from '../lib/iceServers';
import { countryName } from '../lib/countries';
import {
  DUEL_PICKS,
  MILESTONES,
  PICK_EMOJI,
  REACTIONS,
  SPARKS,
  chemistry,
  duelRound,
  formatElapsed,
  type DuelPick,
} from '../lib/callDeck';
import type {
  CallEventMessage,
  CallEventType,
  CallState,
  ChatMessage,
  IceSource,
  MatchInfo,
  NetworkStats,
  SignalMessage,
} from '../types';
import {
  AlertIcon,
  CamIcon,
  CamOffIcon,
  ChatIcon,
  ExpandIcon,
  EyeOffIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  SpinnerIcon,
  flagFromCountry,
} from './icons';

interface Props {
  match: MatchInfo;
  localStream: MediaStream;
  socket: AppSocket;
  /**
   * App owns the socket-level `signal:data` listener so an offer that arrives
   * between `match:found` and this component mounting is buffered instead of
   * lost. Returns an unregister function.
   */
  registerSignal: (roomId: string, handler: (msg: SignalMessage) => void) => () => void;
  /** Hang up and stop on the post-call screen (Next / Stop matching). */
  onEndCall: () => void;
  /** Leave *this* partner and queue for someone new right away. */
  onNext: () => void;
  /**
   * Fires once, on the first transition to `connected` — App uses it to start
   * the clock behind the shareable post-call card. Never called for a call
   * that fails to connect.
   */
  onConnected?: () => void;
  /**
   * The live chemistry score (both screens compute the identical number from
   * the same room-wide events) — App carries it to the post-call recap.
   */
  onChemistry?: (score: number) => void;
}

const STATE_META: Record<CallState, { label: string; className: string }> = {
  connecting: {
    label: 'Connecting',
    className: 'border-warn/40 bg-warn/15 text-warn',
  },
  connected: { label: 'Connected', className: 'border-ok/40 bg-ok/15 text-ok' },
  reconnecting: {
    label: 'Reconnecting…',
    className: 'border-warn/40 bg-warn/15 text-warn',
  },
  failed: { label: 'Unable to connect', className: 'border-danger/40 bg-danger/15 text-danger' },
  closed: { label: 'Call ended', className: 'border-white/15 bg-white/10 text-muted' },
};

const PATH_LABEL: Record<string, string> = {
  host: 'Local network',
  srflx: 'Direct P2P',
  prflx: 'Direct P2P',
  relay: 'Server relay',
  unknown: '…',
};

/** Rock-paper-scissors duel state — identical on both screens by design. */
interface DuelState {
  active: boolean;
  show: boolean;
  round: number;
  scores: [number, number];
  myPick: DuelPick | null;
  peerPick: DuelPick | null;
  line: string | null;
  over: boolean;
}

const INITIAL_DUEL: DuelState = {
  active: false,
  show: false,
  round: 1,
  scores: [0, 0],
  myPick: null,
  peerPick: null,
  line: null,
  over: false,
};

interface Reaction {
  id: number;
  emoji: string;
  mine: boolean;
}

/**
 * The call screen: owns the RTCPeerConnection for the current match — and the
 * in-call **playground**.
 *
 * Lifecycle: mount → fetch ICE config → create Peer → exchange SDP through
 * the signaling socket → render remote media. Unmount (or `attempt` bump)
 * destroys the Peer, which also happens when either side hangs up.
 *
 * The playground (chat · spark cards · rock-paper-scissors duel · floating
 * reactions · chemistry meter · talk-time milestones) rides a separate
 * `call:event` relay channel with its own server-side whitelist and rate
 * limit (see `server/src/matchmaker.js`). All shared state is *derivable*:
 * both sides observe every room event (own sends + partner relays), so the
 * chemistry number, duel scores and spark cards agree without any server
 * state. Rules and content live in `lib/callDeck.ts`.
 *
 * Navigation: every control is a labelled footer button with keyboard
 * shortcuts (M/V/C/S/D/R/F/H, Esc closes panels); **Hide** gives an
 * immersive, chrome-free view with a one-tap way back.
 */
export default function VideoChat({
  match,
  localStream,
  socket,
  registerSignal,
  onEndCall,
  onNext,
  onConnected,
  onChemistry,
}: Props) {
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const peerRef = useRef<Peer | null>(null);

  const [callState, setCallState] = useState<CallState>('connecting');
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [stats, setStats] = useState<NetworkStats | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [micOn, setMicOn] = useState(() =>
    localStream.getAudioTracks().some((t) => t.enabled && t.readyState === 'live'),
  );
  const [camOn, setCamOn] = useState(() =>
    localStream.getVideoTracks().some((t) => t.enabled && t.readyState === 'live'),
  );

  // ── Playground state ─────────────────────────────────────────────────────
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [unread, setUnread] = useState(0);
  const [spark, setSpark] = useState<{ index: number } | null>(null);
  const [reactOpen, setReactOpen] = useState(false);
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [duel, setDuel] = useState<DuelState>(INITIAL_DUEL);
  const [counts, setCounts] = useState({ chat: 0, spark: 0, duel: 0, react: 0 });
  const [uiHidden, setUiHidden] = useState(false);
  const [fsOn, setFsOn] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [milestone, setMilestone] = useState<string | null>(null);
  const [hint, setHint] = useState(false);

  const msgIdRef = useRef(0);
  const reactionIdRef = useRef(0);
  const lastSparkRef = useRef(-1);
  const chatOpenRef = useRef(false);
  const hintShownRef = useRef(false);
  const milestoneFiredRef = useRef(0);
  const clockOnRef = useRef(false);

  const { roomId, initiator, peer } = match;
  const chatInputRef = useRef<HTMLInputElement>(null);

  // ── Call telemetry (`call:report`) ────────────────────────────────────────
  // One row per call answers "did the direct connection work, and how did it
  // perform?" — the server aggregates them in `GET /api/stats` → `calls`.
  const connectedAtRef = useRef<number | null>(null);
  const everConnectedRef = useRef(false);
  const pathReportedRef = useRef(false);
  const lastReportRef = useRef<{ key: string; at: number } | null>(null);
  const lastStatsRef = useRef<NetworkStats | null>(null);
  const iceSourceRef = useRef<IceSource | 'unknown'>('unknown');

  const report = useCallback(
    (outcome: 'connected' | 'failed', force = false) => {
      const key = `${roomId}:${outcome}`;
      const now = Date.now();
      const prev = lastReportRef.current;
      // An identical row repeated within 4s (stats loop, double unmount) is
      // noise — unless the caller explicitly wants the final, forced row.
      if (!force && prev?.key === key && now - prev.at < 4000) return;
      lastReportRef.current = { key, at: now };

      socket.emit('call:report', {
        roomId,
        outcome,
        path: lastStatsRef.current?.path ?? null,
        rttMs: lastStatsRef.current?.rttMs ?? null,
        durationMs: connectedAtRef.current ? now - connectedAtRef.current : null,
        attempts: attempt + 1,
        iceSource: iceSourceRef.current,
      });
    },
    [roomId, socket, attempt],
  );

  // ── Playground plumbing ───────────────────────────────────────────────────

  const sendEvent = useCallback(
    (type: CallEventType, payload: Record<string, string | number>) => {
      socket.emit('call:event', { roomId, type, payload });
    },
    [socket, roomId],
  );

  const pushReaction = useCallback((emoji: string, mine: boolean) => {
    reactionIdRef.current += 1;
    const id = reactionIdRef.current;
    setReactions((prev) => [...prev, { id, emoji, mine }]);
    window.setTimeout(
      () => setReactions((prev) => prev.filter((r) => r.id !== id)),
      2700,
    );
  }, []);

  /** Apply a partner event — receiving never re-sends (no echo loops). */
  const applyDuelEvent = useCallback((payload: Record<string, string | number>) => {
    const action = String(payload.action ?? '');
    if (action === 'start') {
      setDuel((d) => (d.active ? { ...d, show: true } : { ...INITIAL_DUEL, active: true, show: true }));
    } else if (action === 'rematch') {
      setDuel((d) =>
        d.active
          ? { ...d, round: 1, scores: [0, 0], myPick: null, peerPick: null, line: null, over: false, show: true }
          : d,
      );
    } else if (action === 'pick') {
      const pick = String(payload.pick ?? '') as DuelPick;
      if (!DUEL_PICKS.includes(pick)) return;
      const round = Number(payload.round);
      setDuel((d) =>
        d.active && !d.over && d.round === round && !d.peerPick ? { ...d, peerPick: pick } : d,
      );
    }
  }, []);

  // Partner events → the playground (room-scoped, registered once per room).
  useEffect(() => {
    const onCallEvent = (msg: CallEventMessage) => {
      if (msg.roomId !== roomId) return;
      switch (msg.type) {
        case 'chat': {
          const text = String(msg.payload.text ?? '').slice(0, 500);
          if (!text) return;
          msgIdRef.current += 1;
          const id = msgIdRef.current;
          setMessages((prev) => [...prev, { id, mine: false, text }]);
          setCounts((c) => ({ ...c, chat: c.chat + 1 }));
          if (!chatOpenRef.current) setUnread((n) => n + 1);
          return;
        }
        case 'react': {
          const emoji = String(msg.payload.emoji ?? '');
          if (!REACTIONS.includes(emoji)) return;
          pushReaction(emoji, false);
          setCounts((c) => ({ ...c, react: c.react + 1 }));
          return;
        }
        case 'spark': {
          const index = Number(msg.payload.index);
          if (!Number.isInteger(index) || index < 0 || index >= SPARKS.length) return;
          lastSparkRef.current = index;
          setSpark({ index });
          setCounts((c) => ({ ...c, spark: c.spark + 1 }));
          return;
        }
        case 'duel':
          applyDuelEvent(msg.payload);
      }
    };
    socket.on('call:event', onCallEvent);
    return () => {
      socket.off('call:event', onCallEvent);
    };
  }, [socket, roomId, pushReaction, applyDuelEvent]);

  // Chemistry is a pure function of the room's event counts — notify App.
  const chem = chemistry(counts);
  useEffect(() => {
    onChemistry?.(chem);
  }, [chem, onChemistry]);

  // ── Peer lifecycle ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let created: Peer | null = null;
    // SDP can arrive while we are still fetching ICE credentials — the peer
    // object does not exist yet, so hold those messages instead of dropping
    // them (dropping the first offer = a call that never connects).
    const buffered: SignalMessage[] = [];

    // Fresh attempt ⇒ start this room's telemetry row over.
    pathReportedRef.current = false;
    // A brand-new room also resets the timing anchors (the old room's final
    // row was already emitted by the previous cleanup).
    if (!lastReportRef.current?.key.startsWith(`${roomId}:`)) {
      connectedAtRef.current = null;
      everConnectedRef.current = false;
    }

    const handleSignal = (msg: SignalMessage) => {
      if (msg.roomId !== roomId) return;
      if (!created) {
        buffered.push(msg);
        return;
      }
      void created.handleSignal(msg);
    };

    // App's socket listener either routes straight here or flushes what it
    // buffered before this component mounted. Either way, no offer is lost.
    const unregisterSignal = registerSignal(roomId, handleSignal);

    (async () => {
      // Media relay config: no STUN/TURN, so this resolves immediately.
      const { iceServers, source } = await getIceConfig();
      if (cancelled) return;
      iceSourceRef.current = (source ?? 'unknown') as IceSource | 'unknown';

      created = new Peer({
        initiator,
        localStream,
        iceServers,
        send: (payload) => socket.emit('signal:data', { ...payload, roomId }),
        onState: setCallState,
        onRemoteStream: setRemoteStream,
      });
      peerRef.current = created;

      for (const msg of buffered.splice(0)) {
        void created.handleSignal(msg);
      }
    })().catch((err) => {
      console.error('[videochat] failed to create peer:', err);
      setCallState('failed');
    });

    return () => {
      cancelled = true;
      unregisterSignal();
      created?.destroy();
      peerRef.current = null;
      setRemoteStream(null);
      setStats(null);
      // Final row for the room: carries the real duration + last known path.
      // Runs on hang-up, on retry, and on unmount.
      if (everConnectedRef.current) report('connected', true);
    };
  }, [roomId, initiator, socket, localStream, attempt, report, registerSignal]);

  // ── Media elements ─────────────────────────────────────────────────────────
  useEffect(() => {
    const video = localVideoRef.current;
    if (!video) return;
    video.srcObject = localStream;
    void video.play().catch(() => undefined);
  }, [localStream]);

  useEffect(() => {
    const video = remoteVideoRef.current;
    if (!video) return;
    video.srcObject = remoteStream;
    if (remoteStream) void video.play().catch(() => undefined);
  }, [remoteStream]);

  // ── Connection state → telemetry ───────────────────────────────────────────
  useEffect(() => {
    if (callState === 'connected') {
      if (!connectedAtRef.current) {
        connectedAtRef.current = Date.now();
        everConnectedRef.current = true;
        clockOnRef.current = true;
        // First time media actually flows: let App start the shared card's
        // clock (a call that never connects must never be shareable).
        onConnected?.();
        // One-time discoverability beat for the playground buttons.
        if (!hintShownRef.current) {
          hintShownRef.current = true;
          setHint(true);
          window.setTimeout(() => setHint(false), 6500);
        }
      }
      return;
    }
    if (callState === 'failed') report('failed');
  }, [callState, report, onConnected]);

  // ── Talk-time clock + milestones ──────────────────────────────────────────
  useEffect(() => {
    if (!clockOnRef.current) return;
    const id = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [callState]);

  useEffect(() => {
    const m = MILESTONES.find((x) => x.at === elapsed);
    if (!m || milestoneFiredRef.current === m.at) return;
    milestoneFiredRef.current = m.at;
    setMilestone(m.text);
    const t = window.setTimeout(() => setMilestone(null), 3800);
    return () => window.clearTimeout(t);
  }, [elapsed]);

  // ── Live path/RTT readout ──────────────────────────────────────────────────
  useEffect(() => {
    if (callState !== 'connected') return;
    const poll = () => {
      void peerRef.current?.getStats().then((next) => {
        if (!next) return;
        lastStatsRef.current = next;
        setStats(next);
        // First row as soon as the selected candidate pair is known — this is
        // what tells an operator how the direct connection is performing.
        if (!pathReportedRef.current) {
          pathReportedRef.current = true;
          report('connected');
        }
      });
    };
    const id = setInterval(poll, 2000);
    poll();
    return () => clearInterval(id);
  }, [callState, report]);

  // ── Controls ───────────────────────────────────────────────────────────────

  const toggleMic = useCallback(() => {
    const [track] = localStream.getAudioTracks();
    if (!track) return;
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
  }, [localStream]);

  const toggleCam = useCallback(() => {
    const [track] = localStream.getVideoTracks();
    if (!track) return;
    track.enabled = !track.enabled;
    setCamOn(track.enabled);
  }, [localStream]);

  const toggleChat = useCallback(() => {
    const next = !chatOpenRef.current;
    chatOpenRef.current = next;
    setChatOpen(next);
    if (next) {
      setUnread(0);
      window.setTimeout(() => chatInputRef.current?.focus(), 50);
    }
  }, []);

  const drawSpark = useCallback(() => {
    let index = Math.floor(Math.random() * SPARKS.length);
    if (SPARKS.length > 1 && index === lastSparkRef.current) {
      index = (index + 1) % SPARKS.length;
    }
    lastSparkRef.current = index;
    setSpark({ index });
    setCounts((c) => ({ ...c, spark: c.spark + 1 }));
    sendEvent('spark', { index });
  }, [sendEvent]);

  const sendChat = useCallback(
    (text: string) => {
      const clean = text.trim().slice(0, 500);
      if (!clean) return;
      msgIdRef.current += 1;
      const id = msgIdRef.current;
      setMessages((prev) => [...prev, { id, mine: true, text: clean }]);
      setCounts((c) => ({ ...c, chat: c.chat + 1 }));
      sendEvent('chat', { text: clean });
    },
    [sendEvent],
  );

  const sendReaction = useCallback(
    (emoji: string) => {
      pushReaction(emoji, true);
      setCounts((c) => ({ ...c, react: c.react + 1 }));
      sendEvent('react', { emoji });
      setReactOpen(false);
    },
    [pushReaction, sendEvent],
  );

  const toggleDuel = useCallback(() => {
    if (!duel.active) {
      setDuel({ ...INITIAL_DUEL, active: true, show: true });
      sendEvent('duel', { action: 'start' });
      return;
    }
    setDuel((d) => ({ ...d, show: !d.show }));
  }, [duel.active, sendEvent]);

  const pickDuel = (pick: DuelPick) => {
    if (!duel.active || duel.over || duel.myPick) return;
    sendEvent('duel', { action: 'pick', pick, round: duel.round });
    setDuel((d) => (d.myPick ? d : { ...d, myPick: pick }));
  };

  const rematchDuel = useCallback(() => {
    applyDuelEvent({ action: 'rematch' });
    sendEvent('duel', { action: 'rematch' });
  }, [applyDuelEvent, sendEvent]);

  // Both picks in → resolve the round on BOTH screens (identical inputs).
  useEffect(() => {
    if (!duel.active || duel.over || !duel.myPick || !duel.peerPick) return;
    const res = duelRound(duel.myPick, duel.peerPick);
    setDuel((d) => {
      if (!d.myPick || !d.peerPick) return d;
      const scores: [number, number] = [d.scores[0], d.scores[1]];
      if (res.winner === 'me') scores[0] += 1;
      else if (res.winner === 'them') scores[1] += 1;
      return {
        ...d,
        scores,
        line: res.line,
        myPick: null,
        peerPick: null,
        round: d.round + 1,
        over: scores[0] >= 2 || scores[1] >= 2,
      };
    });
    setCounts((c) => ({ ...c, duel: c.duel + 1 }));
  }, [duel]);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void el.requestFullscreen().catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const onFs = () => setFsOn(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // ── Keyboard navigation (Esc closes the top panel, then M/V/C/S/D/R/F/H) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

      if (uiHidden) {
        if (!typing) setUiHidden(false);
        return;
      }
      if (e.key === 'Escape') {
        if (document.fullscreenElement) return; // browser exits fullscreen itself
        if (chatOpenRef.current) toggleChat();
        else if (reactOpen) setReactOpen(false);
        else if (spark) setSpark(null);
        else if (duel.show) setDuel((d) => ({ ...d, show: false }));
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key.toLowerCase()) {
        case 'm':
          toggleMic();
          break;
        case 'v':
          toggleCam();
          break;
        case 'c':
          toggleChat();
          break;
        case 's':
          drawSpark();
          break;
        case 'd':
          toggleDuel();
          break;
        case 'r':
          setReactOpen((o) => !o);
          break;
        case 'f':
          toggleFullscreen();
          break;
        case 'h':
          setUiHidden(true);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Auto-scroll the chat to the newest line.
  useEffect(() => {
    const box = document.getElementById('matchup-chat-log');
    if (box) box.scrollTop = box.scrollHeight;
  }, [messages, chatOpen]);

  const retry = useCallback(() => {
    setCallState('connecting');
    setAttempt((n) => n + 1);
  }, []);

  const meta = STATE_META[callState];
  const pathLabel = stats ? PATH_LABEL[stats.path] ?? '…' : null;

  return (
    <div ref={containerRef} className="relative z-10 flex h-full w-full flex-col">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      {!uiHidden && (
        <header className="flex items-center justify-between gap-3 border-b border-white/10 bg-surface/80 px-4 py-3 backdrop-blur">
          <div className="flex min-w-0 items-center gap-3">
            <span className="text-2xl" role="img" aria-label={`Flag of ${peer.country}`}>
              {flagFromCountry(peer.country)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink">
                {peer.username}
                <span className="ml-2 font-normal text-muted">, {peer.age}</span>
              </p>
              <p className="truncate text-xs text-muted">{countryName(peer.country)}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span
              className="hidden rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs tabular-nums text-muted sm:inline"
              title="Time connected"
            >
              ⏱ {formatElapsed(elapsed)}
            </span>
            <span
              className="hidden items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs sm:flex"
              title="Chemistry — grows as you two interact"
            >
              <span aria-hidden="true">🧬</span>
              <span className="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
                <span
                  className="block h-full rounded-full bg-accent transition-all duration-500"
                  style={{ width: `${chem}%` }}
                />
              </span>
              <span className="font-semibold tabular-nums text-accent">{chem}%</span>
            </span>
            {pathLabel && (
              <span className="hidden rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-muted md:inline">
                {pathLabel}
                {stats?.rttMs != null && <span className="tabular-nums"> · {stats.rttMs} ms</span>}
              </span>
            )}
            <span
              className={`rounded-full border px-3 py-1 text-xs font-semibold ${meta.className}`}
              role="status"
              aria-live="polite"
            >
              {meta.label}
            </span>
          </div>
        </header>
      )}

      {/* ── Stage ──────────────────────────────────────────────────────────── */}
      <main
        className="relative min-h-0 flex-1 bg-black/40"
        onClick={uiHidden ? () => setUiHidden(false) : undefined}
      >
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className={`h-full w-full object-cover transition-opacity duration-500 ${
            remoteStream && callState === 'connected' ? 'opacity-100' : 'opacity-0'
          }`}
        />

        {!remoteStream && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-full border border-white/10 bg-surface-3 text-3xl">
              {flagFromCountry(peer.country)}
            </div>
            <p className="text-sm text-muted">
              {callState === 'failed'
                ? 'No media received from your partner.'
                : `Connecting to ${peer.username}…`}
            </p>
            {callState !== 'failed' && <SpinnerIcon className="h-5 w-5 text-accent" />}
          </div>
        )}

        {callState === 'reconnecting' && (
          <div className="absolute inset-x-0 top-4 mx-auto flex w-fit items-center gap-2 rounded-full border border-warn/40 bg-black/70 px-4 py-2 text-sm font-medium text-warn backdrop-blur">
            <SpinnerIcon className="h-4 w-4" />
            Network hiccup — reconnecting…
          </div>
        )}

        {/* Self view */}
        <div className="absolute bottom-4 right-4 z-10 aspect-[4/3] w-36 overflow-hidden rounded-xl border border-white/15 bg-black shadow-2xl sm:w-48">
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className={`h-full w-full scale-x-[-1] object-cover ${camOn ? '' : 'hidden'}`}
          />
          {!camOn && (
            <div className="flex h-full w-full items-center justify-center bg-surface-3 text-2xl font-semibold text-muted">
              CAM
            </div>
          )}
          {!micOn && (
            <span className="absolute left-1.5 top-1.5 rounded-md bg-danger/85 p-1 text-white">
              <MicOffIcon className="h-3.5 w-3.5" />
            </span>
          )}
        </div>

        {/* Floating reactions — yours and your partner's, same animation. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-24 z-30 flex flex-wrap justify-center gap-4 px-8">
          {reactions.map((r) => (
            <span
              key={r.id}
              className="animate-float-up text-4xl drop-shadow-lg"
              role="img"
              aria-label={`Reaction ${r.emoji}`}
            >
              {r.emoji}
            </span>
          ))}
        </div>

        {/* Spark card — the shared conversation starter. */}
        {spark && (
          <div
            role="status"
            className="animate-pop absolute left-1/2 top-4 z-30 w-[min(92%,26rem)] -translate-x-1/2 rounded-2xl border border-accent/40 bg-surface-2/95 p-4 text-center shadow-2xl backdrop-blur"
          >
            <p className="text-[11px] font-semibold uppercase tracking-widest text-accent">
              ✨ Spark
            </p>
            <p className="mt-1.5 text-sm font-medium leading-snug text-ink">
              {SPARKS[spark.index] ?? 'Say hi in your own way!'}
            </p>
            <div className="mt-3 flex justify-center gap-2">
              <button
                type="button"
                aria-label="Draw another spark"
                onClick={drawSpark}
                className="btn btn-primary px-3 py-1.5 text-xs"
              >
                ✨ Another
              </button>
              <button
                type="button"
                aria-label="Dismiss spark"
                onClick={() => setSpark(null)}
                className="btn btn-ghost px-3 py-1.5 text-xs"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Duel — rock-paper-scissors, first to 2. */}
        {duel.show && (
          <div
            className="absolute inset-0 z-30 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
            onClick={() => setDuel((d) => ({ ...d, show: false }))}
            role="presentation"
          >
            <div
              className="animate-pop card w-full max-w-sm p-5 text-center"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="text-left">
                  <p className="text-xs font-semibold uppercase tracking-widest text-accent">
                    ✊ Duel
                  </p>
                  <p className="mt-1 text-sm font-semibold text-ink">Rock · Paper · Scissors</p>
                  <p className="text-xs text-muted">
                    First to 2 wins · Round {duel.round} · You {duel.scores[0]} —{' '}
                    {duel.scores[1]} {peer.username}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="Close duel"
                  onClick={() => setDuel((d) => ({ ...d, show: false }))}
                  className="btn btn-ghost px-2 py-1 text-xs"
                >
                  ✕
                </button>
              </div>

              {!duel.over && (
                <div className="mt-4 flex justify-center gap-3">
                  {DUEL_PICKS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      aria-label={`Pick ${p}`}
                      disabled={Boolean(duel.myPick)}
                      onClick={() => pickDuel(p)}
                      className={`flex h-20 w-20 flex-col items-center justify-center rounded-2xl border transition-colors ${
                        duel.myPick === p
                          ? 'border-accent/60 bg-accent/20'
                          : duel.myPick
                            ? 'border-white/5 bg-white/5 opacity-50'
                            : 'border-white/15 bg-white/5 hover:border-accent/50 hover:bg-accent/10'
                      }`}
                    >
                      <span className="text-3xl" aria-hidden="true">
                        {PICK_EMOJI[p]}
                      </span>
                      <span className="mt-0.5 text-[10px] capitalize text-muted">{p}</span>
                    </button>
                  ))}
                </div>
              )}

              {!duel.over && duel.myPick && !duel.line && (
                <p className="mt-3 text-sm text-muted">
                  Waiting for {peer.username}… you threw {PICK_EMOJI[duel.myPick]}
                </p>
              )}

              {!duel.over && duel.line && (
                <p className="mt-3 text-sm text-ink" role="status">
                  {duel.myPick || duel.round > 1
                    ? `${duel.line} — pick again for round ${duel.round}`
                    : duel.line}
                </p>
              )}

              {duel.over && (
                <div className="mt-4">
                  <p className="text-lg font-semibold text-ink" role="status">
                    {duel.scores[0] > duel.scores[1]
                      ? '🏆 You won the duel!'
                      : `😅 ${peer.username} won the duel!`}
                  </p>
                  <p className="text-xs text-muted">Final score {duel.scores[0]} — {duel.scores[1]}</p>
                  <button
                    type="button"
                    aria-label="Rematch duel"
                    onClick={rematchDuel}
                    className="btn btn-primary mt-3 px-4 py-2 text-xs"
                  >
                    Rematch
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Chat drawer */}
        {chatOpen && (
          <aside
            aria-label="In-call chat"
            className="absolute inset-y-0 right-0 z-20 flex w-full max-w-xs flex-col border-l border-white/10 bg-surface/95 backdrop-blur"
          >
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                Chat with {peer.username}
              </p>
              <button
                type="button"
                aria-label="Close chat panel"
                onClick={toggleChat}
                className="btn btn-ghost px-2 py-1 text-xs"
              >
                ✕
              </button>
            </div>
            <div
              id="matchup-chat-log"
              className="chat-scroll flex-1 space-y-2 overflow-y-auto px-3 py-3"
            >
              {messages.length === 0 && (
                <p className="text-xs leading-relaxed text-muted">
                  Say hi — {peer.username} sees this even if cameras are off. Your first line
                  nudges the chemistry meter.
                </p>
              )}
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex ${m.mine ? 'justify-end' : 'justify-start'}`}
                >
                  <p
                    className={`max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-sm ${
                      m.mine ? 'bg-accent text-white' : 'bg-white/10 text-ink'
                    }`}
                  >
                    {m.text}
                  </p>
                </div>
              ))}
            </div>
            <form
              className="flex gap-2 border-t border-white/10 p-2"
              onSubmit={(e) => {
                e.preventDefault();
                sendChat(draft);
                setDraft('');
              }}
            >
              <input
                ref={chatInputRef}
                aria-label="Message"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Type a message…"
                maxLength={500}
                className="field flex-1"
              />
              <button type="submit" aria-label="Send message" className="btn btn-primary px-3">
                ➤
              </button>
            </form>
          </aside>
        )}

        {/* Reaction picker */}
        {reactOpen && (
          <div
            aria-label="Reactions"
            className="animate-pop absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 gap-1 rounded-full border border-white/15 bg-surface-2/95 px-3 py-2 shadow-2xl backdrop-blur"
          >
            {REACTIONS.map((e) => (
              <button
                key={e}
                type="button"
                aria-label={`React with ${e}`}
                onClick={() => sendReaction(e)}
                className="rounded-full px-2 py-1 text-2xl transition-transform hover:scale-125"
              >
                {e}
              </button>
            ))}
          </div>
        )}

        {/* Talk-time milestone */}
        {milestone && (
          <div
            role="status"
            className="animate-pop pointer-events-none absolute inset-x-0 top-1/3 z-40 mx-auto w-fit max-w-[90%] rounded-full border border-warn/40 bg-black/85 px-5 py-2.5 text-center text-sm font-medium text-warn backdrop-blur"
          >
            {milestone}
          </div>
        )}

        {/* One-time playground hint */}
        {hint && (
          <div className="animate-pop pointer-events-none absolute inset-x-0 bottom-6 z-40 mx-auto w-fit max-w-[92%] rounded-full border border-accent/40 bg-black/75 px-4 py-2 text-center text-xs text-ink backdrop-blur">
            ✨ Spark · ✊ Duel · 💬 Chat · 😊 React — try them below, or press S / D / C / R
          </div>
        )}

        {/* ── Failure takeover ───────────────────────────────────────────── */}
        {callState === 'failed' && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-surface/85 px-6 backdrop-blur-sm">
            <div className="card max-w-md p-6 text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-danger/15 text-danger">
                <AlertIcon className="h-6 w-6" />
              </div>
              <h2 className="text-lg font-semibold text-ink">Unable to connect</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                We couldn’t start the server relay with {peer.username}. Check your connection
                and try again — switching between Wi-Fi and mobile data can also help.
              </p>
              <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
                <button type="button" onClick={retry} className="btn btn-primary">
                  Try again
                </button>
                <button type="button" onClick={onNext} className="btn btn-ghost">
                  Find someone else
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ── Controls dock ───────────────────────────────────────────────────── */}
      {!uiHidden && (
        <footer className="flex flex-wrap items-center justify-center gap-1.5 border-t border-white/10 bg-surface/85 px-2 py-3 backdrop-blur sm:gap-3 sm:px-4">
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

          <DockButton
            label={chatOpen ? 'Close chat' : 'Open chat (C)'}
            caption="Chat"
            active={chatOpen}
            badge={unread}
            onClick={toggleChat}
          >
            <ChatIcon className="h-5 w-5" />
          </DockButton>

          <DockButton
            label="Draw a spark (S)"
            caption="Spark"
            active={spark !== null}
            onClick={drawSpark}
          >
            <span className="text-lg leading-none" aria-hidden="true">
              ✨
            </span>
          </DockButton>

          <DockButton
            label={duel.show ? 'Close duel' : 'Play duel (D)'}
            caption="Duel"
            active={duel.show}
            onClick={toggleDuel}
          >
            <span className="text-lg leading-none" aria-hidden="true">
              ✊
            </span>
          </DockButton>

          <DockButton
            label={reactOpen ? 'Close reactions' : 'Send a reaction (R)'}
            caption="React"
            active={reactOpen}
            onClick={() => setReactOpen((o) => !o)}
          >
            <span className="text-lg leading-none" aria-hidden="true">
              😊
            </span>
          </DockButton>

          <DockButton label="Hide controls (H)" caption="Hide" onClick={() => setUiHidden(true)}>
            <EyeOffIcon className="h-5 w-5" />
          </DockButton>

          <DockButton
            label={fsOn ? 'Exit fullscreen (F)' : 'Enter fullscreen (F)'}
            caption={fsOn ? 'Window' : 'Full'}
            active={fsOn}
            onClick={toggleFullscreen}
          >
            <ExpandIcon className="h-5 w-5" />
          </DockButton>

          <button
            type="button"
            onClick={onEndCall}
            className="btn btn-danger h-12 w-12 rounded-full p-0 sm:h-12 sm:w-auto sm:px-6"
            title="End call"
            aria-label="End call"
          >
            <PhoneOffIcon className="h-5 w-5" />
            <span className="hidden sm:inline">End call</span>
          </button>
        </footer>
      )}

      {uiHidden && (
        <button
          type="button"
          aria-label="Show controls"
          onClick={() => setUiHidden(false)}
          className="absolute bottom-3 left-1/2 z-40 -translate-x-1/2 rounded-full border border-white/15 bg-black/70 px-4 py-2 text-xs font-medium text-ink backdrop-blur"
        >
          Show controls
        </button>
      )}
    </div>
  );
}

/** One labelled pill in the control dock: circle icon + caption + badge. */
function DockButton({
  label,
  caption,
  onClick,
  active,
  danger,
  ariaPressed,
  badge = 0,
  children,
}: {
  label: string;
  caption: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  ariaPressed?: boolean;
  badge?: number;
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
        className={`relative flex h-11 w-11 items-center justify-center rounded-full border transition-colors ${circle}`}
      >
        {children}
        {badge > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold leading-none text-white">
            {badge}
          </span>
        )}
      </span>
      <span className="text-[10px] font-medium text-muted group-hover:text-ink">{caption}</span>
    </button>
  );
}
