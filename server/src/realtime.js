'use strict';

/**
 * Realtime without a socket.
 *
 * The production runtime (Vercel serverless functions) cannot hold a
 * connection open: every HTTP request is a fresh invocation that may land on a
 * different instance. So the socket.io contract from `protocol.js` is carried
 * over HTTP instead:
 *
 *   POST /api/rt/emit   { event, payload }   client → server (fire and forget)
 *   GET  /api/rt/poll?since=N&wait=20       server → client (long-poll)
 *
 * Server events are rows in `rt_inbox` addressed to the client's session id
 * (`x-matchup-sid`, generated per page load). A poll holds the request open
 * until a row arrives (or `wait` elapses), which keeps latency in the low
 * seconds — SDP/ICE relays go straight to the partner's inbox and surface on
 * their next poll iteration. Presence and queue position ride along on every
 * poll response so no background ticker is needed anywhere.
 *
 * Semantics (queue order, mutual preference, sanitizers, room entitlement)
 * mirror `matchmaker.js` / `rooms.js`, which this module replaces.
 */

const crypto = require('crypto');
const { validateProfile, publicProfile, isMatch } = require('./matchmaking');
const telemetry = require('./telemetry');
const settings = require('./settings');
const accounts = require('./accounts');
const commerce = require('./commerce');
const socialStore = require('./socialStore');
const mariaStore = require('./mariaStore');

/** Max SDP/ICE messages accepted per second from one session. */
const SIGNAL_RATE_LIMIT = 80;
/** In-call playground events get their own, much tighter bucket. */
const CALL_EVENT_RATE_LIMIT = 15;
/** Room signals: far beyond any real call, tight enough to stop a flood. */
const ROOM_SIGNAL_BUDGET = 60;
const CALL_EVENT_TYPES = new Set(['chat', 'react', 'spark', 'duel']);
const REACTION_EMOJI = new Set(['👋', '😂', '❤️', '🔥', '👏', '😮', '🎉']);
const DUEL_ACTIONS = new Set(['start', 'pick', 'rematch']);
const DUEL_PICKS = new Set(['rock', 'paper', 'scissors']);
/** A session counts as online while its poll keeps coming back. */
const SESSION_TTL_MS = 120_000;
/** Inbox rows are read once and forgotten. */
// Live media slices are only useful for a few seconds; a shorter inbox TTL
// keeps the DB from holding minutes of video that nobody will play.
const INBOX_TTL_MS = 2 * 60 * 1000;
/** How long after a call closes a `call:report` for it is still accepted. */
const ROOM_HISTORY_TTL_MS = 15 * 60 * 1000;
/** Long-poll hold: under the function's maxDuration, over a full ICE burst. */
const POLL_WAIT_MS = Number(process.env.RT_POLL_WAIT_MS) || 20_000;
const POLL_WAIT_CAP_MS = 25_000;

const SID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// ── Rebuilt from matchmaker.js ──────────────────────────────────────────────

/** Whitelist-rebuilt playground payloads — anything else is dropped. */
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

const SIGNAL_KINDS = new Set(['offer', 'answer', 'candidate', 'ice', 'media']);
/** Largest base64 slice accepted from a browser. ~67 KB decoded. */
const MAX_MEDIA_CHUNK_CHARS = 90_000;

/** Validate one relayed MediaRecorder slice before it reaches the DB. */
function isMediaChunk(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return (
    typeof raw.mime === 'string' &&
    raw.mime.length > 0 &&
    raw.mime.length <= 80 &&
    typeof raw.data === 'string' &&
    raw.data.length > 0 &&
    raw.data.length <= MAX_MEDIA_CHUNK_CHARS &&
    Number.isInteger(raw.seq)
  );
}

// Per-instance, best-effort buckets: an instance only sees its own traffic,
// which is exactly as much as these were ever meant to stop.
const buckets = new Map();
function allow(bucketKey, sid, limit) {
  const now = Date.now();
  const key = `${bucketKey}:${sid}`;
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= 1000) {
    bucket = { windowStart: now, count: 0 };
    buckets.set(key, bucket);
    if (buckets.size > 20_000) buckets.clear(); // never grow unbounded
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

// ── Inbox ───────────────────────────────────────────────────────────────────

function requireDb() {
  return mariaStore; // throws DB_UNAVAILABLE from query() when unconfigured
}

async function deliver(toSid, event, payload) {
  if (!SID_RE.test(String(toSid || ''))) return;
  await requireDb().query(
    'INSERT INTO rt_inbox (to_sid, event, payload, created_at) VALUES (?, ?, ?, ?)',
    [toSid, event, payload ? JSON.stringify(payload) : null, Date.now()],
  );
}

async function deliverMany(sids, event, payload) {
  for (const sid of new Set(sids)) await deliver(sid, event, payload);
}

async function touchSession(sid, profile) {
  const country =
    profile && typeof profile.country === 'string' && profile.country.length === 2
      ? profile.country.toUpperCase()
      : null;
  await requireDb().query(
    `INSERT INTO rt_sessions (sid, profile, country, at) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       profile = COALESCE(VALUES(profile), profile),
       country = COALESCE(VALUES(country), country),
       at = VALUES(at)`,
    [sid, profile ? JSON.stringify(profile) : null, country, Date.now()],
  );
}

async function presenceSnapshot() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  const [row] = await requireDb().query(
    `SELECT
       (SELECT COUNT(*) FROM rt_sessions WHERE at > ?) AS online,
       (SELECT COUNT(*) FROM rt_queue) AS looking`,
    [cutoff],
  );
  return { online: Number(row?.online || 0), looking: Number(row?.looking || 0) };
}

async function geoPresence() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  const rows = await requireDb().query(
    'SELECT country, COUNT(*) AS n FROM rt_sessions WHERE at > ? AND country IS NOT NULL GROUP BY country',
    [cutoff],
  );
  const byCountry = rows
    .map((r) => ({ code: String(r.country).toUpperCase(), online: Number(r.n) }))
    .sort((a, b) => b.online - a.online || a.code.localeCompare(b.code));
  const located = byCountry.reduce((sum, r) => sum + r.online, 0);
  const { online, looking } = await presenceSnapshot();
  return { online, looking, located, byCountry };
}

// ── Pairs (1v1 calls) ───────────────────────────────────────────────────────

async function findPair(sid) {
  const rows = await requireDb().query(
    'SELECT call_id, room_id, a_sid, b_sid FROM rt_pairs WHERE a_sid = ? OR b_sid = ? LIMIT 1',
    [sid, sid],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    callId: row.call_id,
    roomId: row.room_id,
    aSid: row.a_sid,
    bSid: row.b_sid,
    partnerSid: row.a_sid === sid ? row.b_sid : row.a_sid,
  };
}

async function detachPair(sid) {
  const pair = await findPair(sid);
  if (!pair) return null;
  await requireDb().query('DELETE FROM rt_pairs WHERE call_id = ?', [pair.callId]);
  const now = Date.now();
  await requireDb().query(
    'INSERT INTO rt_pairlog (room_id, sid, ended_at) VALUES (?, ?, ?), (?, ?, ?)',
    [pair.roomId, pair.aSid, now, pair.roomId, pair.bSid, now],
  );
  return pair;
}

async function endCall(sid, reason) {
  const pair = await detachPair(sid);
  if (!pair) return;
  await deliver(pair.partnerSid, 'peer:left', { roomId: pair.roomId, reason });
}

async function recentRoom(sid) {
  const [row] = await requireDb().query(
    'SELECT room_id FROM rt_pairlog WHERE sid = ? AND ended_at > ? ORDER BY ended_at DESC LIMIT 1',
    [sid, Date.now() - ROOM_HISTORY_TTL_MS],
  );
  return row?.room_id || null;
}

// ── Queue (1v1 matchmaking) ─────────────────────────────────────────────────

async function joinQueue(sid, rawProfile, ip) {
  const db = requireDb();
  const profile = validateProfile(rawProfile);
  if (!profile) {
    await deliver(sid, 'server:error', {
      code: 'queue',
      message: 'That profile could not be validated. Please reload and try again.',
    });
    return;
  }
  // Inside a call: the client must end it before queueing again.
  if (await findPair(sid)) return;

  if (settings.get().features.maintenance) {
    await deliver(sid, 'server:error', {
      code: 'queue',
      message: 'Matchmaking is paused for a few minutes of maintenance — try again shortly.',
    });
    return;
  }
  if (accounts.ipBanned(ip) || (await accounts.isBanned(profile.username))) {
    await deliver(sid, 'server:error', {
      code: 'queue',
      message: 'This account has been suspended. Contact support if you think this is a mistake.',
    });
    return;
  }
  accounts.noteQueueIp(profile.username, ip);

  await touchSession(sid, profile);

  // First queued entry that BOTH sides accept (arrival order). Rows older
  // than the queue TTL belong to sessions that stopped polling — skip them
  // (and reap them) rather than matching someone to a ghost.
  const queueTtl = Date.now() - 10 * 60 * 1000;
  await db.query('DELETE FROM rt_queue WHERE joined_at < ?', [queueTtl]);
  const waiting = await db.query(
    'SELECT sid, profile FROM rt_queue WHERE sid <> ? ORDER BY joined_at ASC LIMIT 25',
    [sid],
  );
  for (const row of waiting) {
    let other;
    try {
      other = JSON.parse(row.profile);
    } catch {
      continue;
    }
    if (!isMatch(profile, other)) continue;

    await db.query('DELETE FROM rt_queue WHERE sid IN (?, ?)', [sid, row.sid]);
    const callId = `c_${crypto.randomBytes(8).toString('hex')}`;
    const roomId = `r_${crypto.randomBytes(8).toString('hex')}`;
    await db.query(
      'INSERT INTO rt_pairs (call_id, room_id, a_sid, b_sid, created_at) VALUES (?, ?, ?, ?, ?)',
      [callId, roomId, sid, row.sid, Date.now()],
    );
    // The joiner offers; the waiter answers — one offer per pair, no glare.
    await deliver(sid, 'match:found', { roomId, peer: publicProfile(other), initiator: true });
    await deliver(row.sid, 'match:found', {
      roomId,
      peer: publicProfile(profile),
      initiator: false,
    });
    return;
  }

  await db.query(
    `INSERT INTO rt_queue (sid, profile, joined_at) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE profile = VALUES(profile)`,
    [sid, JSON.stringify(profile), Date.now()],
  );
  const { online, looking } = await presenceSnapshot();
  await deliver(sid, 'match:waiting', { online, looking });
}

async function leaveQueue(sid) {
  await requireDb().query('DELETE FROM rt_queue WHERE sid = ?', [sid]);
  await endCall(sid, 'ended');
}

// ── Rooms (group calls) ─────────────────────────────────────────────────────

/** Human-readable text for every refusal, mirroring rooms.js. */
const REASONS = {
  'payment-required': 'Pay the entry fee to join this room.',
  'adult-only': 'This room is 18+ — it is for accounts aged 18 and over.',
  'room-full': 'That room is full — try the next one.',
  'room-ended': 'That room has ended.',
  unauthorized: 'Sign in to join a room.',
  'groups-disabled': 'Group calls are switched off right now.',
  'not-found': 'That room does not exist.',
};

async function auth(payload) {
  const token = payload && typeof payload.token === 'string' ? payload.token : null;
  if (!token) return null;
  try {
    return await accounts.authenticate(token);
  } catch {
    return null;
  }
}

async function roomError(sid, code, message) {
  await deliver(sid, 'server:error', { code, message: message || REASONS[code] || 'That room cannot be opened right now.' });
}

const ROOM_TTL_MS = 150_000;

async function roster(slug) {
  const rows = await requireDb().query(
    'SELECT sid, account_id, username, country FROM rt_roomlive WHERE slug = ? AND at > ?',
    [slug, Date.now() - ROOM_TTL_MS],
  );
  return rows.map((r) => ({
    sid: r.sid,
    id: Number(r.account_id),
    username: r.username,
    country: r.country || '',
  }));
}

async function broadcastState(slug) {
  const people = await roster(slug);
  await deliverMany(
    people.map((p) => p.sid),
    'room:state',
    {
      slug,
      participants: people.map(({ id, username, country }) => ({ id, username, country })),
      count: people.length,
    },
  );
}

async function joinRoom(sid, user, room) {
  const db = requireDb();
  const max = Math.max(2, room.maxParticipants || 6);
  const people = await roster(room.slug);
  if (room.hostId !== user.id && people.length >= max) {
    await roomError(sid, 'room-full');
    return;
  }
  // One row per account: a second tab replaces the first.
  await db.query('DELETE FROM rt_roomlive WHERE slug = ? AND account_id = ? AND sid <> ?', [
    room.slug,
    user.id,
    sid,
  ]);
  await touchSession(sid, null);
  await db.query(
    `INSERT INTO rt_roomlive (slug, sid, account_id, username, country, at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE account_id = VALUES(account_id),
       username = VALUES(username), country = VALUES(country), at = VALUES(at)`,
    [
      room.slug,
      sid,
      user.id,
      user.username,
      String(user.profile?.country || '').slice(0, 8),
      Date.now(),
    ],
  );
  const fresh = await roster(room.slug);
  await deliver(sid, 'room:joined', {
    room,
    self: { id: user.id, username: user.username },
    peers: fresh.filter((p) => p.id !== user.id).map(({ id, username, country }) => ({ id, username, country })),
  });
  await broadcastState(room.slug);
}

async function onRoomCreate(sid, payload) {
  const user = await auth(payload);
  if (!user) return roomError(sid, 'unauthorized');
  try {
    const room = await commerce.createRoom(user, payload || {});
    await deliver(sid, 'room:created', { room });
    await joinRoom(sid, user, room); // creating IS joining
  } catch (err) {
    await roomError(sid, err.code || 'not-found');
    if (err.code && !REASONS[err.code]) {
      await deliver(sid, 'server:error', { code: err.code, message: err.message });
    }
  }
}

async function onRoomEnter(sid, payload) {
  const user = await auth(payload);
  if (!user) return roomError(sid, 'unauthorized');
  const slug = payload && typeof payload.slug === 'string' ? payload.slug : '';
  if (!slug) return roomError(sid, 'not-found');
  try {
    const room = await socialStore.getRoomBySlug(slug);
    if (!room) return roomError(sid, 'not-found');
    if (room.status === 'ended') return roomError(sid, 'room-ended');
    const access = await commerce.roomAccess(user, room);
    if (!access.canEnter) return roomError(sid, access.reason || 'payment-required');
    await joinRoom(sid, user, room);
  } catch (err) {
    if (err.code === 'DB_UNAVAILABLE') return roomError(sid, 'not-found');
    console.error('[rooms] enter failed:', err.message);
    return roomError(sid, 'not-found');
  }
  return undefined;
}

async function onRoomSignal(sid, payload) {
  if (!payload || typeof payload.slug !== 'string') return;
  if (!SIGNAL_KINDS.has(payload.kind)) return;
  if (payload.kind === 'media' && !isMediaChunk(payload.payload)) return;
  if (!allow('rsig', sid, ROOM_SIGNAL_BUDGET)) return;
  const people = await roster(payload.slug);
  const from = people.find((p) => p.sid === sid);
  if (!from) return;
  const target = Number(payload.to);
  const to = people.find((p) => p.id === target && p.sid !== sid);
  if (!to) return;
  await deliver(to.sid, 'room:signal', {
    slug: payload.slug,
    from: from.id,
    username: from.username,
    kind: payload.kind,
    payload: payload.payload,
  });
}

async function onRoomLeave(sid, payload) {
  const slug = payload && typeof payload.slug === 'string' ? payload.slug : '';
  if (!slug) return;
  const had = await requireDb().query('DELETE FROM rt_roomlive WHERE slug = ? AND sid = ?', [slug, sid]);
  if (had.affectedRows > 0) await broadcastState(slug);
}

async function onRoomEnd(sid, payload) {
  const user = await auth(payload);
  const slug = payload && typeof payload.slug === 'string' ? payload.slug : '';
  if (!user || !slug) return;
  const room = await socialStore.getRoomBySlug(slug).catch(() => null);
  if (!room) return;
  if (room.hostId !== user.id) return;
  await closeRoom(slug, { admin: false });
}

async function closeRoom(slug, { admin = false } = {}) {
  const room = await socialStore.getRoomBySlug(slug).catch(() => null);
  if (!room) return null;
  if (room.status !== 'ended') {
    await socialStore.setRoomStatus(room.id, 'ended').catch((err) => {
      console.error('[rooms] end failed:', err.message);
    });
  }
  const people = await roster(slug);
  await deliverMany(
    people.map((p) => p.sid),
    'room:closed',
    { slug, byAdmin: admin },
  );
  await requireDb().query('DELETE FROM rt_roomlive WHERE slug = ?', [slug]);
  return room;
}

async function roomStats() {
  const [row] = await requireDb().query(
    'SELECT COUNT(DISTINCT slug) AS rooms, COUNT(*) AS participants FROM rt_roomlive WHERE at > ?',
    [Date.now() - ROOM_TTL_MS],
  );
  return { rooms: Number(row?.rooms || 0), participants: Number(row?.participants || 0) };
}

async function withCounts(items) {
  const rows = await requireDb().query(
    'SELECT slug, COUNT(*) AS n FROM rt_roomlive WHERE at > ? GROUP BY slug',
    [Date.now() - ROOM_TTL_MS],
  );
  const counts = new Map(rows.map((r) => [r.slug, Number(r.n)]));
  return items.map((room) => ({ ...room, participants: counts.get(room.slug) || 0 }));
}

// ── Emit dispatcher ─────────────────────────────────────────────────────────

function sidOf(req) {
  const raw = String(req.headers['x-matchup-sid'] || '');
  return SID_RE.test(raw) ? raw : null;
}

async function handleEmit(req, res) {
  const sid = sidOf(req);
  if (!sid) {
    return res.status(400).json({ ok: false, error: 'bad-sid' });
  }
  const { event, payload } = req.body || {};
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  try {
    switch (event) {
      case 'queue:join':
        await joinQueue(sid, payload, ip);
        break;
      case 'queue:leave':
        await leaveQueue(sid);
        break;
      case 'call:end':
        await endCall(sid, 'ended');
        break;
      case 'signal:data': {
        if (!payload || typeof payload !== 'object') break;
        if (!SIGNAL_KINDS.has(payload.kind)) break;
        if (payload.kind === 'media') {
          if (!isMediaChunk(payload.payload)) break;
        } else if (!payload.payload || typeof payload.payload !== 'object') {
          break;
        }
        if (!allow('sig', sid, SIGNAL_RATE_LIMIT)) break;
        const pair = await findPair(sid);
        if (!pair || payload.roomId !== pair.roomId) break; // spoofed / stale room
        await deliver(pair.partnerSid, 'signal:data', {
          roomId: pair.roomId,
          kind: payload.kind,
          payload: payload.payload,
        });
        break;
      }
      case 'call:event': {
        if (!payload || typeof payload.type !== 'string' || !CALL_EVENT_TYPES.has(payload.type)) break;
        if (!allow('cev', sid, CALL_EVENT_RATE_LIMIT)) break;
        const clean = sanitizeCallEvent(payload.type, payload.payload);
        if (!clean) break;
        const pair = await findPair(sid);
        if (!pair || payload.roomId !== pair.roomId) break;
        await deliver(pair.partnerSid, 'call:event', {
          roomId: pair.roomId,
          type: payload.type,
          payload: clean,
        });
        break;
      }
      case 'call:report': {
        if (!payload || typeof payload !== 'object') break;
        const roomId = typeof payload.roomId === 'string' ? payload.roomId : '';
        if (!roomId) break;
        const pair = await findPair(sid);
        const remembered = await recentRoom(sid);
        if (pair?.roomId !== roomId && remembered !== roomId) break;
        if (telemetry.record(payload)) {
          console.info(
            '[call]',
            JSON.stringify({
              room: roomId,
              outcome: payload.outcome,
              path: payload.path ?? null,
              rttMs: payload.rttMs ?? null,
              ms: payload.durationMs ?? null,
              attempts: payload.attempts ?? null,
              ice: payload.iceSource ?? null,
            }),
          );
        }
        break;
      }
      case 'room:create':
        await onRoomCreate(sid, payload || {});
        break;
      case 'room:enter':
        await onRoomEnter(sid, payload || {});
        break;
      case 'room:signal':
        await onRoomSignal(sid, payload || {});
        break;
      case 'room:leave':
        await onRoomLeave(sid, payload || {});
        break;
      case 'room:end':
        await onRoomEnd(sid, payload || {});
        break;
      default:
        break;
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    if (err.code === 'DB_UNAVAILABLE') {
      return res.status(503).json({ ok: false, error: 'db-unavailable' });
    }
    console.error('[rt] emit failed:', err.message);
    return res.status(200).json({ ok: true }); // never surface internals
  }
}

// ── Long-poll ───────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitingSnapshot(sid) {
  const db = requireDb();
  const [mine] = await db.query('SELECT joined_at FROM rt_queue WHERE sid = ?', [sid]);
  if (!mine) return null;
  const [counts] = await db.query(
    'SELECT COUNT(*) AS ahead FROM rt_queue WHERE joined_at < ?',
    [mine.joined_at],
  );
  const { online, looking } = await presenceSnapshot();
  return { online, looking, position: Number(counts?.ahead || 0) + 1 };
}

async function handlePoll(req, res) {
  const sid = sidOf(req);
  if (!sid) return res.status(400).json({ ok: false, error: 'bad-sid' });

  let since = Number(req.query.since);
  if (!Number.isFinite(since) || since < 0) since = 0;
  const wait = Math.min(
    Number(req.query.wait) > 0 ? Number(req.query.wait) : POLL_WAIT_MS,
    POLL_WAIT_CAP_MS,
  );

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    const db = requireDb();
    // The poll is the heartbeat: it keeps the session (and any room row) alive.
    await touchSession(sid, null);
    await db.query('UPDATE rt_roomlive SET at = ? WHERE sid = ?', [Date.now(), sid]);
    await db.query('DELETE FROM rt_inbox WHERE to_sid = ? AND created_at < ?', [
      sid,
      Date.now() - INBOX_TTL_MS,
    ]);
    // Roster rows are filtered by freshness everywhere they are read; reap
    // the expired ones so the table stays tiny.
    await db.query('DELETE FROM rt_roomlive WHERE at < ?', [Date.now() - ROOM_TTL_MS]);
    await db.query('DELETE FROM rt_sessions WHERE at < ?', [Date.now() - SESSION_TTL_MS * 5]);

    const deadline = Date.now() + wait;
    let rows = [];
    for (;;) {
      rows = await db.query(
        'SELECT id, event, payload FROM rt_inbox WHERE to_sid = ? AND id > ? ORDER BY id ASC LIMIT 50',
        [sid, since],
      );
      if (rows.length || Date.now() >= deadline) break;
      await sleep(1200);
    }

    const events = rows.map((r) => ({
      id: Number(r.id),
      event: r.event,
      payload: r.payload ? JSON.parse(r.payload) : null,
    }));
    const cursor = events.length ? events[events.length - 1].id : since;
    const presence = await presenceSnapshot();
    const waiting = await waitingSnapshot(sid);
    return res.status(200).json({ ok: true, events, cursor, presence, waiting });
  } catch (err) {
    if (err.code === 'DB_UNAVAILABLE') {
      return res.status(503).json({ ok: false, error: 'db-unavailable' });
    }
    console.error('[rt] poll failed:', err.message);
    return res.status(200).json({ ok: true, events: [], cursor: since, presence: null, waiting: null });
  }
}

module.exports = {
  handleEmit,
  handlePoll,
  presenceSnapshot,
  geoPresence,
  roomStats,
  withCounts,
  closeRoom,
};
