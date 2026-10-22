/**
 * Signaling protocol shared with the client.
 *
 * ⚠️ Keep in sync with `client/src/lib/signaling.ts`. The server stays plain
 * CommonJS on purpose so it can be deployed to any Node host with no build.
 *
 * Client → Server
 *   queue:join   { profile }          enter the matchmaking queue
 *   queue:leave  {}                   leave the queue / go back to the lobby
 *   signal:data  { roomId, kind, payload }   relay SDP offer/answer/ICE
 *   call:event   { roomId, type, payload }   in-call playground channel
 *                                    (chat / react / spark / duel — whitelisted
 *                                    types, size-capped, own rate limit)
 *   call:end     {}                   hang up the current room
 *   call:report  { roomId, outcome, path, rttMs, durationMs, attempts, iceSource }
 *                                    one telemetry row per call (see telemetry.js)
 *   room:create  { token, title, price, isAdult, max, kind }   open a group room
 *   room:enter   { token, slug }      join a group call / conference (paid entry)
 *   room:signal  { slug, to, kind, payload }  relay SDP/ICE to ONE participant
 *                                    (mesh: every pair runs its own negotiation)
 *   room:leave   { slug }             step out of the room
 *   room:end     { slug }             host closes the room for everyone
 *
 * Server → Client
 *   match:found  { roomId, peer, initiator }   a partner was found
 *   match:waiting{ looking, online }           you are queued (first snapshot)
 *   signal:data  { roomId, kind, payload }     relayed from your partner
 *   call:event   { roomId, type, payload }     relayed from your partner
 *   peer:left    { roomId, reason }            partner hung up / dropped
 *   presence     { looking, online }           periodic live counters
 *   server:error { code, message }             safe-to-display errors
 *   room:created { room }                      your room is open
 *   room:joined  { room, self, peers }         you are in — `peers` to dial
 *   room:signal  { from, kind, payload }       relayed from another participant
 *   room:state   { slug, participants, count } roster changed
 *   room:closed  { slug }                      the host (or an admin) ended it
 */
const CLIENT = Object.freeze({
  QUEUE_JOIN: 'queue:join',
  QUEUE_LEAVE: 'queue:leave',
  SIGNAL: 'signal:data',
  CALL_EVENT: 'call:event',
  CALL_END: 'call:end',
  CALL_REPORT: 'call:report',
  ROOM_CREATE: 'room:create',
  ROOM_ENTER: 'room:enter',
  ROOM_SIGNAL: 'room:signal',
  ROOM_LEAVE: 'room:leave',
  ROOM_END: 'room:end',
});

const SERVER = Object.freeze({
  MATCH_FOUND: 'match:found',
  MATCH_WAITING: 'match:waiting',
  SIGNAL: 'signal:data',
  CALL_EVENT: 'call:event',
  PEER_LEFT: 'peer:left',
  PRESENCE: 'presence',
  ERROR: 'server:error',
  ROOM_CREATED: 'room:created',
  ROOM_JOINED: 'room:joined',
  ROOM_SIGNAL: 'room:signal',
  ROOM_STATE: 'room:state',
  ROOM_CLOSED: 'room:closed',
});

const GENDERS = Object.freeze(['female', 'male', 'nonbinary', 'other']);
const PREFERENCES = Object.freeze(['any', ...GENDERS]);

module.exports = { CLIENT, SERVER, GENDERS, PREFERENCES };
