import type { CallState, NetworkStats, PathType, SignalMessage } from '../types';
import { FALLBACK_ICE_SERVERS } from './iceServers';

type OutgoingSignal = Omit<SignalMessage, 'roomId'>;

export interface PeerOptions {
  /** The side that speaks first. Exactly one peer per match gets `true`. */
  initiator: boolean;
  localStream: MediaStream;
  iceServers: RTCIceServer[];
  /**
   * `'relay'` restricts ICE to TURN candidates only — the "prove the relay
   * actually works" switch, enabled with `?relay=1` on the URL and used by the
   * E2E relay test. Defaults to `'all'` (normal P2P-first behaviour).
   */
  iceTransportPolicy?: RTCIceTransportPolicy;
  /** Push an SDP/ICE message onto the signaling channel. */
  send: (msg: OutgoingSignal) => void;
  onState: (state: CallState) => void;
  onRemoteStream: (stream: MediaStream) => void;
}

/** How long we wait for `connected` before the first ICE restart. */
const CONNECT_TIMEOUT_MS = 20_000;
/** How long a transient `disconnected` is tolerated before we restart ICE. */
const DISCONNECT_GRACE_MS = 6_000;
/** Hard cap before we surface "Unable to connect". */
const MAX_ICE_RESTARTS = 2;

type LooseStats = {
  type?: string;
  state?: string;
  nominated?: boolean;
  selected?: boolean;
  currentRoundTripTime?: number;
  protocol?: string;
  remoteCandidateId?: string;
  candidateType?: string;
  bytesSent?: number;
  bytesReceived?: number;
};
/**
 * A thin, dependency-free wrapper around `RTCPeerConnection`.
 *
 * Why not `simple-peer`? It is unmaintained, pulls in `readable-stream` shims
 * and hides exactly the state machine we need to expose for the UI
 * (connecting → connected → reconnecting → failed). ~200 lines buys us full
 * control over the things that break in production:
 *
 *   • **Perfect negotiation** — the "polite peer" pattern from the W3C spec, so
 *     offer/answer glare (both sides offering at once) resolves instead of
 *     deadlocking the call.
 *   • **ICE restarts** — a Wi-Fi ↔ LTE handoff or a brief NAT refresh shows up
 *     as `disconnected`/`failed`; we retry transparently before giving up.
 *   • **Candidate buffering** — ICE candidates that arrive before the remote
 *     description would otherwise be dropped, which is a classic cause of
 *     "connects 1 time in 3" on high-RTT links.
 *   • **A watchdog** — ICE can hang forever in `checking`; without a timeout the
 *     user stares at a spinner indefinitely.
 */
export class Peer {
  private readonly pc: RTCPeerConnection;
  private readonly remoteStream = new MediaStream();
  private readonly polite: boolean;

  private makingOffer = false;
  private ignoreOffer = false;
  /** Non-initiators stay silent until the first offer arrives. */
  private firstOfferReceived = false;
  private forceIceRestart = false;

  private pendingCandidates: RTCIceCandidateInit[] = [];
  private state: CallState = 'connecting';
  private iceRestarts = 0;
  private destroyed = false;

  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: PeerOptions) {
    this.polite = !opts.initiator;

    this.pc = this.createPeerConnection();

    for (const track of opts.localStream.getTracks()) {
      // Only attach live tracks; a camera the user turned off still has
      // `enabled === false` and is negotiated as a muted track (good: the
      // "camera off" state survives reconnects).
      this.pc.addTrack(track, opts.localStream);
    }

    this.pc.onnegotiationneeded = () => void this.handleNegotiationNeeded();
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) this.opts.send({ kind: 'candidate', payload: ev.candidate.toJSON() });
    };
    this.pc.ontrack = (ev) => {
      if (!this.remoteStream.getTracks().includes(ev.track)) {
        this.remoteStream.addTrack(ev.track);
      }
      ev.track.onended = () => {
        this.remoteStream.removeTrack(ev.track);
      };
      this.opts.onRemoteStream(this.remoteStream);
    };
    this.pc.onconnectionstatechange = () => this.syncState();

    this.setState('connecting');
    this.armConnectWatchdog(CONNECT_TIMEOUT_MS);
  }

  /**
   * Build the RTCPeerConnection, degrading to STUN-only if the browser
   * rejects the ICE config outright.
   *
   * `getIceConfig()` already filters malformed URLs, but a constructor throw
   * here would fail *every* call instead of merely losing the relay path —
   * and that exact failure has happened in production: one bad `TURN_URLS`
   * line made `new RTCPeerConnection()` throw
   * `SyntaxError: ICE server parsing failed: Invalid hostname format` and
   * video chat died app-wide until the value was caught.
   */
  private createPeerConnection(): RTCPeerConnection {
    const config: RTCConfiguration = {
      iceServers: this.opts.iceServers,
      // `'relay'` (from `?relay=1`) forces every candidate through TURN — used
      // to verify the relay path end to end without needing a strict NAT.
      iceTransportPolicy: this.opts.iceTransportPolicy ?? 'all',
      // Gather a few candidates in parallel — trades a little bandwidth for a
      // noticeably shorter time-to-first-frame on lossy links.
      iceCandidatePoolSize: 4,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    };
    try {
      return new RTCPeerConnection(config);
    } catch (err) {
      console.warn('[peer] browser rejected the ICE config; retrying STUN-only:', err);
      return new RTCPeerConnection({ ...config, iceServers: FALLBACK_ICE_SERVERS });
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Feed a message that came in over the signaling channel. */
  async handleSignal(msg: OutgoingSignal): Promise<void> {
    if (this.destroyed) return;

    try {
      if (msg.kind === 'candidate') {
        const candidate = msg.payload as RTCIceCandidateInit;
        if (!this.pc.remoteDescription) {
          // Remote description not applied yet — buffer instead of dropping.
          this.pendingCandidates.push(candidate);
          return;
        }
        await this.pc.addIceCandidate(candidate);
        return;
      }

      const description = msg.payload as RTCSessionDescriptionInit;
      const isOffer = description.type === 'offer';

      if (isOffer) this.firstOfferReceived = true;

      // ── Perfect negotiation (W3C "polite peer" pattern) ───────────────────
      const collision =
        isOffer && (this.makingOffer || this.pc.signalingState !== 'stable');
      this.ignoreOffer = !this.polite && collision;
      if (this.ignoreOffer) return;

      await this.pc.setRemoteDescription(description);

      // Flush candidates that raced ahead of the remote description.
      const queued = this.pendingCandidates.splice(0);
      for (const candidate of queued) {
        try {
          await this.pc.addIceCandidate(candidate);
        } catch (e) {
          console.warn('[peer] dropping buffered candidate:', e);
        }
      }

      if (isOffer) {
        await this.pc.setLocalDescription();
        const local = this.pc.localDescription;
        if (local?.type === 'answer') {
          this.opts.send({ kind: 'answer', payload: local });
        }
      }
    } catch (err) {
      // A failed addIceCandidate for an ignored offer is expected noise.
      if (!this.ignoreOffer) {
        console.error('[peer] failed to apply remote signal:', err);
      }
    }
  }

  /** Ask the browser to renegotiate with fresh ICE credentials. */
  restartIce(): void {
    if (this.destroyed) return;
    if (this.iceRestarts >= MAX_ICE_RESTARTS) {
      this.fail();
      return;
    }
    this.iceRestarts += 1;
    console.info(`[peer] ICE restart #${this.iceRestarts}`);

    if (typeof this.pc.restartIce === 'function') {
      // Sets the negotiation-needed flag; the handler creates the offer.
      this.pc.restartIce();
    } else {
      // Older Safari: force it manually.
      this.forceIceRestart = true;
      if (this.pc.signalingState === 'stable') void this.handleNegotiationNeeded();
    }
  }

  /** Selected candidate pair + RTT — shown in the call HUD ("P2P" vs "TURN"). */
  async getStats(): Promise<NetworkStats | null> {
    if (this.destroyed) return null;
    try {
      const report = await this.pc.getStats();

      type PairStats = LooseStats & {
        id?: string;
        localCandidateId?: string;
        remoteCandidateId?: string;
      };

      const all = new Map<string, PairStats>();
      const succeeded: PairStats[] = [];

      report.forEach((entry) => {
        const s = entry as unknown as PairStats;
        if (s.id) all.set(s.id, s);
        if (s.type === 'candidate-pair' && s.state === 'succeeded') {
          succeeded.push(s);
        }
      });

      // Prefer the nominated pair, then any pair that is actually moving bytes.
      // (`nominated` is only briefly true on some agents, so fall back rather
      // than showing a blank HUD.)
      const pair =
        succeeded.find((p) => p.nominated) ||
        succeeded.find((p) => (p.bytesReceived ?? 0) > 0 || (p.bytesSent ?? 0) > 0) ||
        succeeded[0];
      if (!pair) return null;

      const localType = pair.localCandidateId
        ? all.get(pair.localCandidateId)?.candidateType
        : undefined;
      const remoteType = pair.remoteCandidateId
        ? all.get(pair.remoteCandidateId)?.candidateType
        : undefined;

      const path = (remoteType ?? localType ?? 'host') as PathType;
      return {
        path,
        rttMs:
          typeof pair.currentRoundTripTime === 'number'
            ? Math.round(pair.currentRoundTripTime * 1000)
            : null,
        protocol: pair.protocol ?? null,
      };
    } catch {
      return null;
    }
  }

  /** Tear down deterministically: timers first, then the peer connection. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearTimers();

    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    try {
      // NOTE: tracks of the *shared* local MediaStream are left untouched —
      // the same stream is reused for the next match. `pc.close()` only tears
      // down this connection's senders/receivers.
      this.pc.close();
    } catch {
      /* already closed */
    }
    this.pendingCandidates = [];
    this.state = 'closed';
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async handleNegotiationNeeded(): Promise<void> {
    if (this.destroyed || this.pc.signalingState !== 'stable') return;
    // The answering side waits for the initiator's first offer so the very
    // first exchange cannot collide. After that, either side may renegotiate
    // (ICE restarts included) and the polite-peer logic handles collisions.
    if (!this.opts.initiator && !this.firstOfferReceived) return;

    try {
      this.makingOffer = true;

      if (this.forceIceRestart) {
        this.forceIceRestart = false;
        await this.pc.setLocalDescription(await this.pc.createOffer({ iceRestart: true }));
      } else {
        // Implicit createOffer() — also picks up an ICE restart when the
        // browser flagged one via restartIce().
        await this.pc.setLocalDescription();
      }

      const local = this.pc.localDescription;
      if (!local) return;
      if (local.type === 'offer' || local.type === 'answer') {
        this.opts.send({ kind: local.type, payload: local });
      }
    } catch (err) {
      console.error('[peer] negotiation failed:', err);
    } finally {
      this.makingOffer = false;
    }
  }

  private syncState(): void {
    if (this.destroyed) return;

    const connection = this.pc.connectionState;
    const ice = this.pc.iceConnectionState;

    if (connection === 'connected' || ice === 'completed' || ice === 'connected') {
      this.clearConnectTimer();
      this.clearGraceTimer();
      this.setState('connected');
      return;
    }

    if (connection === 'failed' || ice === 'failed') {
      if (this.iceRestarts < MAX_ICE_RESTARTS) {
        this.setState('reconnecting');
        this.restartIce();
        this.armConnectWatchdog(CONNECT_TIMEOUT_MS);
      } else {
        this.fail();
      }
      return;
    }

    if (connection === 'disconnected' || ice === 'disconnected') {
      // Usually transient (network switch, brief packet loss). Give it a
      // grace period before burning an ICE restart.
      if (this.state !== 'reconnecting') {
        this.setState('reconnecting');
        this.armGraceTimer();
      }
      return;
    }

    if (connection === 'closed') {
      this.setState('closed');
      return;
    }

    if (connection === 'connecting' || ice === 'checking' || ice === 'new') {
      this.setState(this.state === 'reconnecting' ? 'reconnecting' : 'connecting');
    }
  }

  private armConnectWatchdog(ms: number): void {
    this.clearConnectTimer();
    this.connectTimer = setTimeout(() => {
      if (this.destroyed || this.state === 'connected') return;
      if (this.iceRestarts < MAX_ICE_RESTARTS) {
        // Symmetric NAT / slow STUN: one well-timed restart often succeeds
        // where the first attempt hung in `checking`.
        this.setState('reconnecting');
        this.restartIce();
        this.armConnectWatchdog(CONNECT_TIMEOUT_MS);
      } else {
        this.fail();
      }
    }, ms);
  }

  private armGraceTimer(): void {
    this.clearGraceTimer();
    this.graceTimer = setTimeout(() => {
      if (this.destroyed || this.state === 'connected') return;
      this.restartIce();
      this.armConnectWatchdog(CONNECT_TIMEOUT_MS);
    }, DISCONNECT_GRACE_MS);
  }

  private fail(): void {
    if (this.destroyed) return;
    this.clearTimers();
    this.setState('failed');
  }

  private setState(next: CallState): void {
    if (this.state === next || this.destroyed) return;
    this.state = next;
    this.opts.onState(next);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private clearGraceTimer(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearConnectTimer();
    this.clearGraceTimer();
  }
}
