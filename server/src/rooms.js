/**
 * Group rooms — the signaling behind group calls and18+ conferences.
 *
 * The 1v1 matchmaker (`matchmaker.js`) stays exactly as it is; this hub is a
 * second, parallel participant in every socket connection. A room is a
 * Socket.io room (`g_<slug>`) plus an in-memory roster, backed by a `rooms`
 * row so it survives a server restart as a listing (participants reconnect).
 *
 * **Mesh, not an MCU.** Every participant runs one `RTCPeerConnection` per
 * remote participant — no media server, so the platform's cost of a 6-way call
 * is zero. The pair that offers is decided by account id (`higher id dials`),
 * which both sides compute identically: exactly one offer per pair, no glare,
 * and the W3C perfect-negotiation logic in `lib/peer.ts` covers the rest.
 *
 * **Entry is a payment.** `room:enter` re-checks entitlement on the server
 * (`commerce.roomAccess`) — a paid room cannot be joined by merely knowing
 * the slug.18+ rooms additionally require an account aged 18+, which
 * `commerce.isAdultAllowed` decides (never the client).
 */
const { CLIENT, SERVER } = require('./protocol');
const accounts = require('./accounts');
const commerce = require('./commerce');
const socialStore = require('./socialStore');

/** Human-readable text for every refusal the client can hit on `room:enter`. */
const REASONS = {
  'payment-required': 'Pay the entry fee to join this room.',
  'adult-only': 'This room is18+ — it is for accounts aged 18 and over.',
  'room-full': 'That room is full — try the next one.',
  'room-ended': 'That room has ended.',
  unauthorized: 'Sign in to join a room.',
  'groups-disabled': 'Group calls are switched off right now.',
  'not-found': 'That room does not exist.',
};

/** Signals are small SDP/ICE blobs — 60/s/socket is far beyond any real call. */
const SIGNAL_BUDGET = 60;

class RoomHub {
  constructor(io) {
    this.io = io;
    /**
     * slug → { room, participants: Map<socketId, {socketId, accountId, username, country}> }
     * Only LIVE rooms with at least one participant are held here; the roster
     * is ephemeral state (a dropped socket must not be remembered as present).
     */
    this.rooms = new Map();
    /** socketId → Set<slug> — what a disconnect has to clean up. */
    this.bySocket = new Map();
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  attach(socket) {
    const signals = { window: Date.now(), count: 0 };

    socket.on(CLIENT.ROOM_CREATE, (payload) => void this.onCreate(socket, payload));
    socket.on(CLIENT.ROOM_ENTER, (payload) => void this.onEnter(socket, payload));
    socket.on(CLIENT.ROOM_LEAVE, (payload) => this.onLeave(socket, payload));
    socket.on(CLIENT.ROOM_END, (payload) => void this.onEnd(socket, payload));
    socket.on(CLIENT.ROOM_SIGNAL, (payload) => {
      // Rate limit synchronously: an SDP flood must be stopped before it is
      // relayed, not after.
      const now = Date.now();
      if (now - signals.window > 1000) {
        signals.window = now;
        signals.count = 0;
      }
      signals.count += 1;
      if (signals.count > SIGNAL_BUDGET) return;
      this.onSignal(socket, payload);
    });

    socket.on('disconnect', () => this.onDisconnect(socket));
  }

  /** Socket → account. Rooms are never anonymous: `token` rides each request. */
  async auth(payload) {
    const token = payload && typeof payload.token === 'string' ? payload.token : null;
    if (!token) return null;
    try {
      return await accounts.authenticate(token);
    } catch {
      return null;
    }
  }

  error(socket, code) {
    socket.emit(SERVER.ERROR, {
      code,
      message: REASONS[code] || 'That room cannot be opened right now.',
    });
  }

  // ── Roster helpers ────────────────────────────────────────────────────────

  channel(slug) {
    return `g_${slug}`;
  }

  ensureRoom(room) {
    let entry = this.rooms.get(room.slug);
    if (!entry) {
      entry = { room, participants: new Map() };
      this.rooms.set(room.slug, entry);
    }
    entry.room = room; // refresh price/status from the row
    return entry;
  }

  roster(entry) {
    return [...entry.participants.values()].map((p) => ({
      id: p.accountId,
      username: p.username,
      country: p.country,
    }));
  }

  broadcastState(entry) {
    this.io.to(this.channel(entry.room.slug)).emit(SERVER.ROOM_STATE, {
      slug: entry.room.slug,
      participants: this.roster(entry),
      count: entry.participants.size,
    });
  }

  track(socket, slug) {
    if (!this.bySocket.has(socket.id)) this.bySocket.set(socket.id, new Set());
    this.bySocket.get(socket.id).add(slug);
  }

  // ── Events ────────────────────────────────────────────────────────────────

  /** `room:create` → open the room and drop the host straight into it. */
  async onCreate(socket, payload) {
    const user = await this.auth(payload);
    if (!user) return this.error(socket, 'unauthorized');
    try {
      const room = await commerce.createRoom(user, payload || {});
      socket.emit(SERVER.ROOM_CREATED, { room });
      // Creating IS joining — a host should never see their own empty room.
      await this.join(socket, user, room);
    } catch (err) {
      this.error(socket, err.code || 'not-found');
      if (err.code && !REASONS[err.code]) {
        // Validation messages (title, adult rules) are written for humans —
        // pass them through verbatim rather than replacing with a generic.
        socket.emit(SERVER.ERROR, { code: err.code, message: err.message });
      }
    }
  }

  /** `room:enter` → entitlement, age, capacity — then the roster. */
  async onEnter(socket, payload) {
    const user = await this.auth(payload);
    if (!user) return this.error(socket, 'unauthorized');
    const slug = payload && typeof payload.slug === 'string' ? payload.slug : '';
    if (!slug) return this.error(socket, 'not-found');

    try {
      const room = await socialStore.getRoomBySlug(slug);
      if (!room) return this.error(socket, 'not-found');
      const access = await commerce.roomAccess(user, room);
      if (!access.canEnter) return this.error(socket, access.reason || 'payment-required');
      await this.join(socket, user, room);
      return undefined;
    } catch (err) {
      if (err.code === 'DB_UNAVAILABLE') return this.error(socket, 'not-found');
      console.error('[rooms] enter failed:', err.message);
      return this.error(socket, 'not-found');
    }
  }

  async join(socket, user, room) {
    const entry = this.ensureRoom(room);
    if (
      room.hostId !== user.id &&
      entry.participants.size >= Math.max(2, room.maxParticipants || 6)
    ) {
      return this.error(socket, 'room-full');
    }

    // One row per account: a second tab replaces the first instead of
    // doubling the roster with a participant nobody can dial.
    for (const [id, existing] of entry.participants) {
      if (existing.accountId === user.id && id !== socket.id) {
        entry.participants.delete(id);
        this.io.sockets.sockets.get(id)?.leave(this.channel(room.slug));
      }
    }

    entry.participants.set(socket.id, {
      socketId: socket.id,
      accountId: user.id,
      username: user.username,
      country: user.profile?.country || '',
    });
    this.track(socket, room.slug);
    await socket.join(this.channel(room.slug));

    // The joiner gets the roster to dial; everyone (joiner included) then gets
    // `room:state`, which is what each client actually syncs its peers from.
    socket.emit(SERVER.ROOM_JOINED, {
      room: entry.room,
      self: { id: user.id, username: user.username },
      peers: this.roster(entry).filter((p) => p.id !== user.id),
    });
    this.broadcastState(entry);
    return undefined;
  }

  /** `room:signal` → relay one SDP/ICE message to exactly one participant. */
  onSignal(socket, payload) {
    if (!payload || typeof payload.slug !== 'string') return;
    const entry = this.rooms.get(payload.slug);
    if (!entry) return;
    const from = entry.participants.get(socket.id);
    if (!from) return;
    if (!['offer', 'answer', 'candidate'].includes(payload.kind)) return;

    const targetAccountId = Number(payload.to);
    for (const participant of entry.participants.values()) {
      if (participant.accountId === targetAccountId && participant.socketId !== socket.id) {
        this.io.to(participant.socketId).emit(SERVER.ROOM_SIGNAL, {
          slug: entry.room.slug,
          from: from.accountId,
          username: from.username,
          kind: payload.kind,
          payload: payload.payload,
        });
        return;
      }
    }
  }

  /** `room:leave` → step out; the roster follows immediately. */
  onLeave(socket, payload) {
    const slug = payload && typeof payload.slug === 'string' ? payload.slug : '';
    if (slug) this.remove(socket, slug);
  }

  /** `room:end` → the host closes the room for everyone (admin does the same). */
  async onEnd(socket, payload) {
    const user = await this.auth(payload);
    const slug = payload && typeof payload.slug === 'string' ? payload.slug : '';
    if (!user || !slug) return;
    const entry = this.rooms.get(slug);
    const room = entry?.room ?? (await socialStore.getRoomBySlug(slug).catch(() => null));
    if (!room) return;
    if (room.hostId !== user.id) return;
    await this.close(slug, { admin: false });
  }

  /** Remove one socket from one room and tell the roommates. */
  remove(socket, slug) {
    const entry = this.rooms.get(slug);
    if (!entry) return;
    const had = entry.participants.delete(socket.id);
    this.bySocket.get(socket.id)?.delete(slug);
    socket.leave(this.channel(slug));
    if (had) this.broadcastState(entry);
    if (entry.participants.size === 0) {
      // The ROOM stays live on purpose: its link keeps working while the host
      // pops out to answer a call. Only `room:end` / an admin closes it.
      this.rooms.delete(slug);
    }
  }

  onDisconnect(socket) {
    const slugs = this.bySocket.get(socket.id);
    if (!slugs) return;
    for (const slug of [...slugs]) this.remove(socket, slug);
    this.bySocket.delete(socket.id);
  }

  /**
   * Close a room for everyone: DB status flips to `ended`, every participant
   * gets `room:closed` and is dropped from the roster.
   * Called by the host, by `room:end`, and by the dashboard's Rooms tab.
   */
  async close(slug, { admin = false } = {}) {
    const entry = this.rooms.get(slug);
    const room = entry?.room ?? (await socialStore.getRoomBySlug(slug).catch(() => null));
    if (!room) return null;

    if (room.status !== 'ended') {
      await socialStore.setRoomStatus(room.id, 'ended').catch((err) => {
        console.error('[rooms] end failed:', err.message);
      });
    }
    this.io.to(this.channel(slug)).emit(SERVER.ROOM_CLOSED, { slug, byAdmin: admin });
    if (entry) {
      for (const socketId of entry.participants.keys()) {
        this.io.sockets.sockets.get(socketId)?.leave(this.channel(slug));
      }
      this.rooms.delete(slug);
    }
    for (const [socketId, slugs] of this.bySocket) slugs.delete(slug) || undefined;
    return room;
  }

  /** Live numbers for `/health` and the dashboard's Overview. */
  stats() {
    let participants = 0;
    for (const entry of this.rooms.values()) participants += entry.participants.size;
    return { rooms: this.rooms.size, participants };
  }

  /** How many people are in one room right now (the public listing shows it). */
  liveCount(slug) {
    return this.rooms.get(slug)?.participants.size ?? 0;
  }

  withCounts(items) {
    return items.map((room) => ({ ...room, participants: this.liveCount(room.slug) }));
  }
}

module.exports = { RoomHub, REASONS };
