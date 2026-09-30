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
 *
 * Server → Client
 *   match:found  { roomId, peer, initiator }   a partner was found
 *   match:waiting{ looking, online }           you are queued (first snapshot)
 *   signal:data  { roomId, kind, payload }     relayed from your partner
 *   call:event   { roomId, type, payload }     relayed from your partner
 *   peer:left    { roomId, reason }            partner hung up / dropped
 *   presence     { looking, online }           periodic live counters
 *   server:error { code, message }             safe-to-display errors
 */
const CLIENT = Object.freeze({
  QUEUE_JOIN: 'queue:join',
  QUEUE_LEAVE: 'queue:leave',
  SIGNAL: 'signal:data',
  CALL_EVENT: 'call:event',
  CALL_END: 'call:end',
  CALL_REPORT: 'call:report',
});

const SERVER = Object.freeze({
  MATCH_FOUND: 'match:found',
  MATCH_WAITING: 'match:waiting',
  SIGNAL: 'signal:data',
  CALL_EVENT: 'call:event',
  PEER_LEFT: 'peer:left',
  PRESENCE: 'presence',
  ERROR: 'server:error',
});

const GENDERS = Object.freeze(['female', 'male', 'nonbinary', 'other']);
const PREFERENCES = Object.freeze(['any', ...GENDERS]);

module.exports = { CLIENT, SERVER, GENDERS, PREFERENCES };
