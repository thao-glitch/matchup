const crypto = require('crypto');
const { CLIENT, SERVER } = require('./protocol');
const { validateProfile, publicProfile, isMatch } = require('./matchmaking');
const telemetry = require('./telemetry');
const settings = require('./settings');
const accounts = require('./accounts');

/** Max SDP/ICE messages accepted per second from a single socket. */
const SIGNAL_RATE_LIMIT = 80;
/**
 * In-call playground events (chat / react / spark / duel) get their own,
 * much tighter bucket: a human cannot honestly send more than ~10/s, and the
 * fun channel must never crowd out the SDP relay above.
 */
const CALL_EVENT_RATE_LIMIT = 15;
/** The whitelisted playground channels — everything else is dropped. */
const CALL_EVENT_TYPES = new Set(['chat', 'react', 'spark', 'duel']);
/** Reaction palette — mirrored in `client/src/lib/callDeck.ts`. */
const REACTION_EMOJI = new Set(['👋', '😂', '❤️', '🔥', '👏', '😮', '🎉']);
const DUEL_ACTIONS = new Set(['start', 'pick', 'rematch']);
const DUEL_PICKS = new Set(['rock', 'paper', 'scissors']);

/**
 * Rebuild the payload field-by-field against a whitelist — anything
 * unexpected is dropped, never forwarded. Returns `null` = reject.
 */
function sanitizeCallEvent(type, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  switch (type) {
    case 'chat': {
      if (typeof raw.text !== 'string') return null;
      const text = raw.text.trim().slice(0, 500);
      return text ? { text } : null;
    }
    case 'react':
      return REACTION_EMOJI.has(raw.emoji) ? { emoji: raw.emoji } : null;
    case 'spark': {
      const index = Number(raw.index);
      if (!Number.isInteger(index) || index < 0 || index >= 500) return null;
      return { index };
    }
    case 'duel': {
      if (!DUEL_ACTIONS.has(raw.action)) return null;
      const out = { action: raw.action };
      if (raw.action === 'pick') {
        if (!DUEL_PICKS.has(raw.pick)) return null;
        out.pick = raw.pick;
        const round = Number(raw.round);
        if (Number.isInteger(round) && round >= 0 && round < 100) out.round = round;
      }
      return out;
    }
    default:
      return null;
  }
}
/** Presence broadcasts are coalesced so a busy queue cannot flood clients. */
const PRESENCE_THROTTLE_MS = 2000;
/** How long after a room closes a `call:report` for it is still accepted. */
const ROOM_HISTORY_TTL_MS = 15 * 60 * 1000;

/**
 * FIFO matchmaking with mutual preference filtering.
 *
 * "First available" means: when User A joins we scan the existing queue in
 * arrival order and take the FIRST User B that BOTH sides accept. If nobody
 * qualifies, A is appended to the queue and shown live counters until a
 * compatible partner shows up.
 *
 * The matchmaker is intentionally in-memory: it maps 1:1 onto a single Node
 * process. For horizontal scaling put the queue in Redis and add the Socket.io
 * Redis adapter (see README → "Scaling").
 */
class Matchmaker {
  constructor(io, store) {
    this.io = io;
    this.store = store;

    /** @type {Array<{socketId: string, profile: object, joinedAt: number}>} */
    this.queue = [];
    /** socketId -> { id, partnerId, partnerProfile } */
    this.rooms = new Map();
    /** socketId -> { joinedAt, signals } — light per-socket rate limiting. */
    this.buckets = new Map();
    /** socketId -> { windowStart, count } — bucket for `call:event`. */
    this.eventBuckets = new Map();
    /**
     * socketId -> { roomId, at } for rooms that just closed. A `call:report`
     * usually lands *after* `call:end` detached the room (React unmounts the
     * call screen on hang-up), so authorization has to look backwards too.
     */
    this.roomHistory = new Map();

    this.lastPresenceAt = 0;
    this.presenceTimer = null;
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  attach(socket) {
    socket.on(CLIENT.QUEUE_JOIN, (profile) => {
      // `joinQueue` awaits the ban check — never let a rejected promise turn
      // into an unhandled rejection that would take the process down.
      Promise.resolve(this.joinQueue(socket, profile)).catch((err) =>
        console.error('[matchmaker] queue:join failed:', err.message),
      );
    });
    socket.on(CLIENT.QUEUE_LEAVE, () => this.leaveQueue(socket));
    socket.on(CLIENT.CALL_END, () => this.endCall(socket, 'ended'));
    socket.on(CLIENT.SIGNAL, (msg) => this.relaySignal(socket, msg));
    socket.on(CLIENT.CALL_EVENT, (msg) => this.relayCallEvent(socket, msg));
    socket.on(CLIENT.CALL_REPORT, (report) => this.reportCall(socket, report));
    socket.on('disconnect', () => this.handleDisconnect(socket));
  }

  // ── Queue ──────────────────────────────────────────────────────────────────

  joinQueue(socket, rawProfile) {
    const profile = validateProfile(rawProfile);
    if (!profile) {
      socket.emit(SERVER.ERROR, {
        code: 'queue',
        message: 'That profile could not be validated. Please reload and try again.',
      });
      return Promise.resolve();
    }

    // Already inside a call: the client must end it before queueing again.
    if (this.rooms.has(socket.id)) return Promise.resolve();

    return this.authorizeJoin(socket, profile).then(() => {
      this.acceptJoin(socket, profile);
    });
  }

  /**
   * Everything a queue join must satisfy BEFORE anything is written:
   *
   *   • maintenance — the dashboard's kill switch (a `features.maintenance`
   *     flip pauses matchmaking without a redeploy);
   *   • bans — by username (the suspended account itself) and by address (the
   *     network they are sitting on), so "new username, same laptop" is not a
   *     way back in.
   *
   * A refusal is always a `server:error{code:'queue'}`, which the lobby renders
   * as a normal error and leaves the user on the start screen.
   */
  async authorizeJoin(socket, profile) {
    if (settings.get().features.maintenance) {
      socket.emit(SERVER.ERROR, {
        code: 'queue',
        message: 'Matchmaking is paused for a few minutes of maintenance — try again shortly.',
      });
      return;
    }

    const ip = this.clientIp(socket);
    if (accounts.ipBanned(ip) || (await accounts.isBanned(profile.username))) {
      socket.emit(SERVER.ERROR, {
        code: 'queue',
        message: 'This account has been suspended. Contact support if you think this is a mistake.',
      });
      return;
    }

    // Keep the address a ban would later act on up to date (fire and forget).
    accounts.noteQueueIp(profile.username, ip);
  }

  /**
   * Where the browser is really connecting from: the platform (Koyeb, Render,
   * Cloudflare) terminates TLS in front of us, so the truth is in
   * X-Forwarded-For and `handshake.address` is only the proxy's address.
   */
  clientIp(socket) {
    const xff = socket.handshake?.headers?.['x-forwarded-for'];
    const first = Array.isArray(xff) ? xff[0] : xff;
    const raw = String(first || socket.handshake?.address || '').split(',')[0].trim();
    return raw.replace(/^::ffff:/i, '').slice(0, 45);
  }

  acceptJoin(socket, profile) {

    this.store.saveProfile(socket.id, profile);
    // Remember the profile on the socket itself: it is what powers the public
    // per-country presence board (see `geoPresence`). Lives exactly as long as
    // the connection does, and is never returned to anyone but an aggregate.
    socket.data.profile = profile;

    const alreadyQueued = this.queue.some((entry) => entry.socketId === socket.id);
    const entry =
      this.queue.find((e) => e.socketId === socket.id) ||
      { socketId: socket.id, profile, joinedAt: Date.now() };
    // A repeat join (profile refresh / reconnect) updates the stored snapshot.
    entry.profile = profile;

    // Scan in arrival order and take the first entry BOTH sides accept —
    // never matching a socket with itself.
    const partner = this.queue.find(
      (e) => e.socketId !== socket.id && isMatch(profile, e.profile),
    );

    if (partner) {
      // Drop our own entry before pairing (pair() removes the partner's).
      if (alreadyQueued) {
        this.queue = this.queue.filter((e) => e.socketId !== socket.id);
      }
      this.pair(entry, partner);
      return;
    }

    if (!alreadyQueued) {
      this.queue.push(entry);
      this.schedulePresence();
    }
    this.emitWaiting(socket);
  }

  leaveQueue(socket) {
    this.queue = this.queue.filter((entry) => entry.socketId !== socket.id);
    // Leaving the queue while in a call also ends the call.
    if (this.rooms.has(socket.id)) this.endCall(socket, 'ended');
    this.schedulePresence();
  }

  /** First queued entry that BOTH sides accept. */
  findMatch(profile) {
    return this.queue.find((entry) => isMatch(profile, entry.profile)) || null;
  }

  pair(entry, partner) {
    this.queue = this.queue.filter((e) => e.socketId !== partner.socketId);

    const a = this.io.sockets.sockets.get(entry.socketId);
    const b = this.io.sockets.sockets.get(partner.socketId);

    // One side vanished between matching and pairing — put the survivor back.
    if (!a || !b) {
      if (a) this.queue.push(entry);
      if (b) this.queue.push({ ...partner, joinedAt: Date.now() });
      this.schedulePresence();
      return;
    }

    const roomId = `r_${crypto.randomBytes(8).toString('hex')}`;

    this.rooms.set(a.id, { id: roomId, partnerId: b.id, partnerProfile: partner.profile });
    this.rooms.set(b.id, { id: roomId, partnerId: a.id, partnerProfile: entry.profile });

    void a.join(roomId);
    void b.join(roomId);

    // The initiator is the peer that creates the SDP offer — this is what
    // breaks offer/answer glare without a round-trip of negotiation.
    a.emit(SERVER.MATCH_FOUND, {
      roomId,
      peer: publicProfile(partner.profile),
      initiator: true,
    });
    b.emit(SERVER.MATCH_FOUND, {
      roomId,
      peer: publicProfile(entry.profile),
      initiator: false,
    });

    this.schedulePresence();
  }

  endCall(socket, reason) {
    const room = this.rooms.get(socket.id);
    if (!room) return;

    this.detach(socket.id);
    const partner = this.io.sockets.sockets.get(room.partnerId);
    if (partner) {
      this.detach(partner.id);
      partner.emit(SERVER.PEER_LEFT, { roomId: room.id, reason });
    }
    this.schedulePresence();
  }

  handleDisconnect(socket) {
    this.queue = this.queue.filter((entry) => entry.socketId !== socket.id);
    // A dropped socket is not the same as a deliberate hang-up — the client
    // shows "Stranger disconnected" for both, but the reason matters for logs.
    if (this.rooms.has(socket.id)) this.endCall(socket, 'disconnected');
    this.buckets.delete(socket.id);
    this.eventBuckets.delete(socket.id);
    // Gone sockets cannot file a report — free the authorization history.
    this.roomHistory.delete(socket.id);
    this.schedulePresence();
  }

  // ── Signal relay ───────────────────────────────────────────────────────────

  /**
   * Media flows peer-to-peer; this only forwards small SDP/ICE blobs between
   * the two members of a room. Anything malformed or destined for a foreign
   * room is dropped.
   */
  relaySignal(socket, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind !== 'offer' && msg.kind !== 'answer' && msg.kind !== 'candidate') return;
    if (!msg.payload || typeof msg.payload !== 'object') return;
    if (!this.allowSignal(socket)) return;

    const room = this.rooms.get(socket.id);
    if (!room || msg.roomId !== room.id) return; // spoofed / stale room

    const partner = this.io.sockets.sockets.get(room.partnerId);
    if (!partner) return;

    partner.emit(SERVER.SIGNAL, {
      roomId: room.id,
      kind: msg.kind,
      payload: msg.payload,
    });
  }

  allowSignal(socket) {
    const now = Date.now();
    let bucket = this.buckets.get(socket.id);
    if (!bucket || now - bucket.windowStart >= 1000) {
      bucket = { windowStart: now, count: 0 };
      this.buckets.set(socket.id, bucket);
    }
    bucket.count += 1;
    return bucket.count <= SIGNAL_RATE_LIMIT;
  }

  // ── In-call playground relay (chat / reactions / sparks / duels) ──────────

  /**
   * Same room discipline as `signal:data` (partner-only, spoofed rooms
   * dropped) but with a per-type whitelist and its own rate limit: the
   * payload is re-sanitized server-side so a modified client cannot push
   * oversized or unexpected data into someone else's call.
   */
  relayCallEvent(socket, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.type !== 'string' || !CALL_EVENT_TYPES.has(msg.type)) return;
    if (!this.allowCallEvent(socket)) return;

    const payload = sanitizeCallEvent(msg.type, msg.payload);
    if (!payload) return;

    const room = this.rooms.get(socket.id);
    if (!room || msg.roomId !== room.id) return; // spoofed / stale room

    const partner = this.io.sockets.sockets.get(room.partnerId);
    if (!partner) return;

    partner.emit(SERVER.CALL_EVENT, { roomId: room.id, type: msg.type, payload });
  }

  allowCallEvent(socket) {
    const now = Date.now();
    let bucket = this.eventBuckets.get(socket.id);
    if (!bucket || now - bucket.windowStart >= 1000) {
      bucket = { windowStart: now, count: 0 };
      this.eventBuckets.set(socket.id, bucket);
    }
    bucket.count += 1;
    return bucket.count <= CALL_EVENT_RATE_LIMIT;
  }

  // ── Call telemetry ─────────────────────────────────────────────────────────

  /**
   * Accept a `call:report` only if the sender was genuinely in that room —
   * either right now, or in the last few minutes (the report is emitted while
   * the call screen unmounts, i.e. usually after `call:end` closed the room).
   * Everything else is dropped rather than poisoning the stats.
   */
  reportCall(socket, report) {
    if (!report || typeof report !== 'object') return;
    const roomId = typeof report.roomId === 'string' ? report.roomId : '';
    if (!roomId) return;

    const active = this.rooms.get(socket.id);
    const remembered = this.recentRoom(socket.id);
    if (active?.id !== roomId && remembered !== roomId) return;

    if (telemetry.record(report)) {
      console.info(
        '[call]',
        JSON.stringify({
          room: roomId,
          outcome: report.outcome,
          path: report.path ?? null,
          rttMs: report.rttMs ?? null,
          ms: report.durationMs ?? null,
          attempts: report.attempts ?? null,
          ice: report.iceSource ?? null,
        }),
      );
    }
  }

  recentRoom(socketId) {
    const entry = this.roomHistory.get(socketId);
    if (!entry) return null;
    if (Date.now() - entry.at > ROOM_HISTORY_TTL_MS) {
      this.roomHistory.delete(socketId);
      return null;
    }
    return entry.roomId;
  }

  rememberRoom(socketId, roomId) {
    const now = Date.now();
    if (this.roomHistory.size > 500) {
      for (const [id, h] of this.roomHistory) {
        if (now - h.at > ROOM_HISTORY_TTL_MS) this.roomHistory.delete(id);
      }
      while (this.roomHistory.size > 1000) {
        this.roomHistory.delete(this.roomHistory.keys().next().value);
      }
    }
    this.roomHistory.set(socketId, { roomId, at: now });
  }

  // ── Presence ───────────────────────────────────────────────────────────────

  presence() {
    return {
      online: this.io.sockets.sockets.size,
      looking: this.queue.length,
    };
  }

  /**
   * `presence()` split by country — the live board behind "#europe".
   *
   * Country comes from the profile each socket submitted on `queue:join`;
   * sockets that never queued (someone who only opened the landing page) have
   * no location and are counted in `online` but not in any row. Only the
   * aggregate ever leaves this process: no username, no IP, no timestamp.
   */
  geoPresence() {
    const counts = new Map();
    for (const socket of this.io.sockets.sockets.values()) {
      const code = socket.data?.profile?.country;
      if (typeof code !== 'string' || code.length !== 2) continue;
      counts.set(code.toUpperCase(), (counts.get(code.toUpperCase()) || 0) + 1);
    }
    const byCountry = [...counts.entries()]
      .map(([code, online]) => ({ code, online }))
      .sort((a, b) => b.online - a.online || a.code.localeCompare(b.code));

    let located = 0;
    for (const total of counts.values()) located += total;

    const { online, looking } = this.presence();
    return { online, looking, located, byCountry };
  }

  emitWaiting(socket) {
    socket.emit(SERVER.MATCH_WAITING, this.presence());
  }

  schedulePresence() {
    const now = Date.now();
    if (now - this.lastPresenceAt < PRESENCE_THROTTLE_MS) return;
    this.lastPresenceAt = now;
    this.io.emit(SERVER.PRESENCE, this.presence());
  }

  /** Periodic tick so counters stay fresh while users are waiting. */
  startTicker(intervalMs = 5000) {
    this.stopTicker();
    this.presenceTimer = setInterval(() => {
      this.io.emit(SERVER.PRESENCE, this.presence());
    }, intervalMs);
    // Never keep the process alive just for a timer.
    this.presenceTimer.unref?.();
  }

  stopTicker() {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
  }

  detach(socketId) {
    const room = this.rooms.get(socketId);
    if (!room) return;
    this.rooms.delete(socketId);
    // Keep the room id around briefly: `call:report` arrives after unmount.
    this.rememberRoom(socketId, room.id);
    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) void socket.leave(room.id);
  }

  stats() {
    return this.presence();
  }
}

module.exports = { Matchmaker };
