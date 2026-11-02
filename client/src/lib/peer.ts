import type {
  CallState,
  MediaChunk,
  NetworkStats,
  PathType,
  SignalMessage,
} from '../types';

type OutgoingSignal = Omit<SignalMessage, 'roomId'>;

export interface PeerOptions {
  /** The side that speaks first. Exactly one peer per match gets `true`. */
  initiator: boolean;
  localStream: MediaStream;
  /** Empty means "use the app-server relay" (the default, STUN-free mode). */
  iceServers: RTCIceServer[];
  /** Push an SDP/ICE/media message onto the signaling channel. */
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
/** MediaRecorder slice size. Larger slices = less DB traffic, more latency. */
const RELAY_CHUNK_MS = 800;
/** Keep a single base64 chunk below the server's validation limit. */
const RELAY_MAX_CHUNK_CHARS = 90_000;

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

// ── WebRTC transport (kept for direct/LAN use; not selected in relay mode) ──

/**
 * A thin, dependency-free wrapper around `RTCPeerConnection`.
 *
 * This is only used if `PeerOptions.iceServers` is non-empty. Matchup's default
 * configuration is empty, so the relay transport below is selected instead.
 * Keeping the WebRTC path means a future LAN-only/direct mode does not need a
 * second implementation.
 */
class WebRtcPeer {
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

  private createPeerConnection(): RTCPeerConnection {
    const config: RTCConfiguration = {
      iceServers: this.opts.iceServers,
      iceCandidatePoolSize: 4,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    };
    try {
      return new RTCPeerConnection(config);
    } catch (err) {
      console.warn('[peer] browser rejected the ICE config; retrying without ICE servers:', err);
      return new RTCPeerConnection({ ...config, iceServers: [] });
    }
  }

  async handleSignal(msg: OutgoingSignal): Promise<void> {
    if (this.destroyed || msg.kind === 'media') return;

    try {
      if (msg.kind === 'candidate') {
        const candidate = msg.payload as RTCIceCandidateInit;
        if (!this.pc.remoteDescription) {
          this.pendingCandidates.push(candidate);
          return;
        }
        await this.pc.addIceCandidate(candidate);
        return;
      }

      const description = msg.payload as RTCSessionDescriptionInit;
      const isOffer = description.type === 'offer';

      if (isOffer) this.firstOfferReceived = true;

      const collision =
        isOffer && (this.makingOffer || this.pc.signalingState !== 'stable');
      this.ignoreOffer = !this.polite && collision;
      if (this.ignoreOffer) return;

      await this.pc.setRemoteDescription(description);

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
      if (!this.ignoreOffer) {
        console.error('[peer] failed to apply remote signal:', err);
      }
    }
  }

  restartIce(): void {
    if (this.destroyed) return;
    if (this.iceRestarts >= MAX_ICE_RESTARTS) {
      this.fail();
      return;
    }
    this.iceRestarts += 1;
    console.info(`[peer] ICE restart #${this.iceRestarts}`);

    if (typeof this.pc.restartIce === 'function') {
      this.pc.restartIce();
    } else {
      this.forceIceRestart = true;
      if (this.pc.signalingState === 'stable') void this.handleNegotiationNeeded();
    }
  }

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

      const candidatePath = remoteType ?? localType ?? 'host';
      const path: PathType =
        candidatePath === 'host' ||
        candidatePath === 'srflx' ||
        candidatePath === 'prflx' ||
        candidatePath === 'relay'
          ? candidatePath
          : 'unknown';
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

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearTimers();

    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    try {
      this.pc.close();
    } catch {
      /* already closed */
    }
    this.pendingCandidates = [];
    this.state = 'closed';
  }

  private async handleNegotiationNeeded(): Promise<void> {
    if (this.destroyed || this.pc.signalingState !== 'stable') return;
    if (!this.opts.initiator && !this.firstOfferReceived) return;

    try {
      this.makingOffer = true;

      if (this.forceIceRestart) {
        this.forceIceRestart = false;
        await this.pc.setLocalDescription(await this.pc.createOffer({ iceRestart: true }));
      } else {
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

// ── App-server relay transport (no STUN, no TURN) ───────────────────────────

const RECORDER_MIMES = [
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
];

function pickRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  return RECORDER_MIMES.find((mime) => MediaRecorder.isTypeSupported(mime)) ?? '';
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToBytes(data: string): Uint8Array | null {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * MediaRecorder → signaling server → MediaSource.
 *
 * Each side records its local camera/mic into small WebM (or MP4) slices and
 * sends them over the same reliable channel as SDP/ICE. The partner appends
 * the slices to a `MediaSource` and exposes the resulting `<video>` as a
 * `MediaStream`, so the rest of the call UI is unchanged.
 *
 * This is deliberately not WebRTC: it has no ICE, no STUN, no TURN and no NAT
 * dependency. It works anywhere the app's HTTP signaling works. The trade-off
 * is latency (roughly 1–3 seconds) and server bandwidth.
 */
class RelayPeer {
  private readonly video: HTMLVideoElement;
  private readonly mediaSource: MediaSource;
  private readonly objectUrl: string;
  private readonly remoteStream = new MediaStream();

  private sourceBuffer: SourceBuffer | null = null;
  private remoteMime = '';
  private queue: ArrayBuffer[] = [];
  private recorder: MediaRecorder | null = null;
  private mime = '';
  private seq = 0;
  private state: CallState = 'connecting';
  private destroyed = false;
  private connected = false;
  private streamAnnounced = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: PeerOptions) {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.setAttribute('aria-hidden', 'true');
    this.video.style.cssText =
      'position:fixed;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(this.video);

    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.video.src = this.objectUrl;
    this.mediaSource.addEventListener('sourceopen', this.onSourceOpen);

    this.startRecorder();
    this.setState('connecting');
    this.armConnectTimer();
  }

  async handleSignal(msg: OutgoingSignal): Promise<void> {
    if (this.destroyed || msg.kind !== 'media') return;
    const chunk = msg.payload as MediaChunk;
    if (!chunk || typeof chunk.mime !== 'string' || typeof chunk.data !== 'string') return;

    const bytes = base64ToBytes(chunk.data);
    if (!bytes) return;

    // Copy into a plain ArrayBuffer: `appendBuffer` rejects SharedArrayBuffer
    // views in some browsers, and the decoder may hand back either.
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);

    this.remoteMime = chunk.mime;
    this.queue.push(buffer);
    this.ensureSourceBuffer();
    this.flush();

    if (!this.connected) {
      this.connected = true;
      this.clearConnectTimer();
      this.setState('connected');
      this.announceStream();
    }
  }

  restartIce(): void {
    // The relay has no ICE. A stalled relay is detected by the watchdog; the
    // signaling layer reconnects its own long-poll independently.
  }

  async getStats(): Promise<NetworkStats | null> {
    if (this.destroyed || !this.connected) return null;
    return { path: 'relay', rttMs: null, protocol: 'http-relay' };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearConnectTimer();

    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop();
      } catch {
        /* already stopped */
      }
    }
    this.recorder = null;

    this.mediaSource.removeEventListener('sourceopen', this.onSourceOpen);
    if (this.sourceBuffer) {
      this.sourceBuffer.removeEventListener('updateend', this.onUpdateEnd);
      this.sourceBuffer = null;
    }
    this.queue = [];

    try {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      this.video.remove();
    } catch {
      /* already detached */
    }
    try {
      if (this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
    } catch {
      /* already closed */
    }
    URL.revokeObjectURL(this.objectUrl);

    this.state = 'closed';
  }

  private startRecorder(): void {
    this.mime = pickRecorderMime();
    if (!this.mime) {
      console.warn('[relay] this browser has no supported MediaRecorder format');
      this.fail();
      return;
    }

    try {
      const recorder = new MediaRecorder(this.opts.localStream, {
        mimeType: this.mime,
        videoBitsPerSecond: 350_000,
        audioBitsPerSecond: 48_000,
      });
      recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0 || this.destroyed) return;
        void this.sendBlob(event.data);
      };
      recorder.onerror = (event) => {
        console.warn('[relay] MediaRecorder error:', event);
        this.fail();
      };
      recorder.start(RELAY_CHUNK_MS);
      this.recorder = recorder;
    } catch (err) {
      console.warn('[relay] MediaRecorder unavailable:', err);
      this.fail();
    }
  }

  private async sendBlob(blob: Blob): Promise<void> {
    try {
      const buffer = await blob.arrayBuffer();
      if (this.destroyed) return;
      const data = bytesToBase64(new Uint8Array(buffer));
      if (!data || data.length > RELAY_MAX_CHUNK_CHARS) {
        console.warn('[relay] dropping oversized media chunk:', data.length);
        return;
      }
      this.seq += 1;
      this.opts.send({
        kind: 'media',
        payload: { mime: this.mime, seq: this.seq, data },
      });
    } catch (err) {
      console.warn('[relay] failed to encode media chunk:', err);
    }
  }

  private readonly onSourceOpen = (): void => {
    this.ensureSourceBuffer();
  };

  private readonly onUpdateEnd = (): void => {
    this.flush();
  };

  private ensureSourceBuffer(): void {
    if (this.destroyed || this.sourceBuffer) return;
    if (this.mediaSource.readyState !== 'open' || !this.remoteMime) return;
    try {
      const sourceBuffer = this.mediaSource.addSourceBuffer(this.remoteMime);
      sourceBuffer.mode = 'segments';
      sourceBuffer.addEventListener('updateend', this.onUpdateEnd);
      this.sourceBuffer = sourceBuffer;
      this.flush();
    } catch (err) {
      console.warn('[relay] MediaSource cannot play this format:', err);
      this.fail();
    }
  }

  private flush(): void {
    if (this.destroyed || !this.sourceBuffer || this.sourceBuffer.updating) return;
    const next = this.queue.shift();
    if (!next) return;
    try {
      this.sourceBuffer.appendBuffer(next);
    } catch (err) {
      console.warn('[relay] failed to append media chunk:', err);
      this.fail();
    }
  }

  private announceStream(): void {
    if (this.streamAnnounced) return;
    this.streamAnnounced = true;

    // Do not wait for `play()` to settle: on some Chromium builds the promise
    // stays pending while the hidden element is offscreen, even though the
    // MediaSource is already producing frames. `captureStream()` works as soon
    // as the decoder has a track, so retry briefly instead.
    void this.video.play().catch(() => undefined);
    this.tryAnnounceStream(0);
  }

  private tryAnnounceStream(attempt: number): void {
    if (this.destroyed) return;
    try {
      const capture = (
        this.video as HTMLVideoElement & {
          captureStream?: () => MediaStream;
        }
      ).captureStream;
      const stream =
        typeof capture === 'function' ? capture.call(this.video) : this.remoteStream;
      if (stream.getTracks().length === 0 && attempt < 30) {
        setTimeout(() => this.tryAnnounceStream(attempt + 1), 100);
        return;
      }
      this.opts.onRemoteStream(stream);
    } catch (err) {
      console.warn('[relay] captureStream unavailable:', err);
      this.opts.onRemoteStream(this.remoteStream);
    }
  }

  private armConnectTimer(): void {
    this.clearConnectTimer();
    this.connectTimer = setTimeout(() => {
      if (this.destroyed || this.connected) return;
      this.fail();
    }, CONNECT_TIMEOUT_MS);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private fail(): void {
    if (this.destroyed) return;
    this.clearConnectTimer();
    this.setState('failed');
  }

  private setState(next: CallState): void {
    if (this.state === next || this.destroyed) return;
    this.state = next;
    this.opts.onState(next);
  }
}

// ── Public facade ───────────────────────────────────────────────────────────

interface PeerImpl {
  handleSignal(msg: OutgoingSignal): Promise<void>;
  restartIce(): void;
  getStats(): Promise<NetworkStats | null>;
  destroy(): void;
}

/**
 * Pick the media transport once, at construction:
 *
 *   iceServers.length === 0  →  app-server relay (the default)
 *   iceServers.length  > 0   →  legacy WebRTC path
 *
 * Callers do not change; `VideoChat` and `RoomPage` keep using `new Peer(...)`.
 */
export class Peer {
  private readonly impl: PeerImpl;

  constructor(opts: PeerOptions) {
    this.impl = opts.iceServers.length === 0 ? new RelayPeer(opts) : new WebRtcPeer(opts);
  }

  handleSignal(msg: OutgoingSignal): Promise<void> {
    return this.impl.handleSignal(msg);
  }

  restartIce(): void {
    this.impl.restartIce();
  }

  getStats(): Promise<NetworkStats | null> {
    return this.impl.getStats();
  }

  destroy(): void {
    this.impl.destroy();
  }
}
