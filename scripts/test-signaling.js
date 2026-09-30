/**
 * End-to-end test of the signaling layer: two simulated clients go through
 * queue → match → SDP/ICE relay → hang-up. No browser needed.
 *
 *   npm run test:signaling
 *
 * Starts the server itself if one is not already listening on :4000.
 */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

// socket.io-client ships with the frontend; resolve it without a second install.
function loadSocketClient() {
  try {
    return require(path.join(__dirname, '..', 'client', 'node_modules', 'socket.io-client'));
  } catch {
    return require('socket.io-client');
  }
}
const { io } = loadSocketClient();

const URL = process.env.URL || 'http://localhost:4000';
const results = [];
const fail = (msg) => {
  results.push(`FAIL: ${msg}`);
  console.error(`FAIL: ${msg}`);
};
const pass = (msg) => {
  results.push(`ok: ${msg}`);
  console.log(`ok: ${msg}`);
};

const waitFor = (sock, event, timeout = 4000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeout);
    sock.once(event, (...args) => {
      clearTimeout(t);
      resolve(args.length === 1 ? args[0] : args);
    });
  });

const profileA = {
  username: 'alice',
  age: 24,
  gender: 'female',
  country: 'KE',
  preferredGenders: ['male'],
  ageMin: 18,
  ageMax: 35,
};

const profileB = {
  username: 'bob',
  age: 27,
  gender: 'male',
  country: 'DE',
  preferredGenders: ['female'],
  ageMin: 18,
  ageMax: 40,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ping() {
  return new Promise((resolve) => {
    // The deployed endpoint is https://…trycloudflare.com — node's `http`
    // module rejects that scheme outright, so pick the client by protocol.
    // (`URL` is only ever a full origin here, never a path.)
    const client = URL.startsWith('https:') ? require('https') : http;
    const req = client.get(`${URL}/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Start the signaling server if nothing is listening yet. */
async function ensureServer() {
  if (await ping()) return null;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..', 'server'),
    env: { ...process.env, PORT: '4000', CORS_ORIGIN: '*' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (await ping()) return child;
  }
  child.kill();
  throw new Error('signaling server did not start on :4000');
}

async function connect(name) {
  const sock = io(URL, { transports: ['websocket'], reconnection: false, timeout: 4000 });
  await waitFor(sock, 'connect').catch((e) => {
    throw new Error(`${name} failed to connect: ${e.message}`);
  });
  return sock;
}

let spawnedServer = null;

async function main() {
  spawnedServer = await ensureServer();

  // 1. presence on connect
  const a = await connect('A');
  const presencePromise = waitFor(a, 'presence');
  const presence = await presencePromise;
  if (typeof presence.online === 'number') pass(`presence received: ${JSON.stringify(presence)}`);
  else fail('presence payload malformed');

  // 2. invalid profile is rejected
  const errPromise = waitFor(a, 'server:error');
  a.emit('queue:join', { username: 'x', age: 5 });
  const err = await errPromise;
  if (err.code === 'queue') pass('invalid profile rejected with server:error');
  else fail(`expected queue error, got ${JSON.stringify(err)}`);

  // 3. incompatible profile → waiting snapshot (no match yet)
  const waitingPromise = waitFor(a, 'match:waiting');
  a.emit('queue:join', profileA); // wants men, age 18-35
  const waiting = await waitingPromise;
  if (waiting.looking >= 1) pass(`queued, waiting snapshot: ${JSON.stringify(waiting)}`);
  else fail('waiting snapshot missing looking count');

  // 4. incompatible partner (woman outside A's age range) does NOT match
  const b = await connect('B');
  const profileBOld = { ...profileB, age: 60, ageMax: 60, ageMin: 45 }; // outside A's 18-35
  b.emit('queue:join', profileBOld);
  const bWaiting = await waitFor(b, 'match:waiting');
  if (bWaiting.looking >= 2) pass('age-incompatible user queued instead of matched');
  else fail(`expected 2 queued, got ${JSON.stringify(bWaiting)}`);

  // 5. compatible partner DOES match, with opposite initiator flags
  const foundA = waitFor(a, 'match:found');
  const profileB2 = { ...profileB, age: 28 };
  b.emit('queue:join', profileB2);
  const foundB = await waitFor(b, 'match:found');
  const aFound = await foundA;

  if (aFound.roomId === foundB.roomId) pass(`matched in room ${aFound.roomId}`);
  else fail(`room mismatch: ${aFound.roomId} vs ${foundB.roomId}`);
  if (aFound.initiator !== foundB.initiator)
    pass('exactly one side is the initiator');
  else fail(`initiator flags wrong: ${JSON.stringify([aFound.initiator, foundB.initiator])}`);
  if (aFound.peer.username === 'bob' && foundB.peer.username === 'alice')
    pass('peer profiles exchanged');
  else fail('peer profile exchange wrong');
  if ('ageMin' in aFound.peer || 'preferredGenders' in aFound.peer)
    fail('internal profile fields leaked to the partner');
  else pass('only public fields shared with the partner');

  // 6. SDP relay both ways
  const relayedToB = waitFor(b, 'signal:data');
  a.emit('signal:data', {
    roomId: aFound.roomId,
    kind: 'offer',
    payload: { type: 'offer', sdp: 'v=0 fake-sdp' },
  });
  const msg = await relayedToB;
  if (msg.kind === 'offer' && msg.payload.sdp === 'v=0 fake-sdp' && msg.roomId === aFound.roomId)
    pass('offer relayed to partner');
  else fail(`bad relay: ${JSON.stringify(msg)}`);

  const relayedToA = waitFor(a, 'signal:data');
  b.emit('signal:data', {
    roomId: foundB.roomId,
    kind: 'answer',
    payload: { type: 'answer', sdp: 'v=0 fake-answer' },
  });
  const msg2 = await relayedToA;
  if (msg2.kind === 'answer') pass('answer relayed back');
  else fail('answer not relayed');

  // 7. signal for a foreign room is dropped
  let leaked = false;
  b.once('signal:data', () => {
    leaked = true;
  });
  a.emit('signal:data', { roomId: 'r_forged', kind: 'offer', payload: { type: 'offer' } });
  await new Promise((r) => setTimeout(r, 400));
  if (!leaked) pass('foreign-room signal dropped');
  else fail('foreign-room signal was relayed');

  // 7b. call:event (chat/duel/spark/react playground) relays partner-only
  const chatRelay = waitFor(b, 'call:event');
  a.emit('call:event', {
    roomId: aFound.roomId,
    type: 'chat',
    payload: { text: 'hi from A' },
  });
  const chatMsg = await chatRelay;
  if (
    chatMsg.type === 'chat' &&
    chatMsg.payload.text === 'hi from A' &&
    chatMsg.roomId === aFound.roomId
  )
    pass('call:event chat relayed to partner');
  else fail(`bad call:event relay: ${JSON.stringify(chatMsg)}`);

  // 7c. forged rooms and non-whitelisted event types are dropped
  let eventLeaked = false;
  b.once('call:event', () => {
    eventLeaked = true;
  });
  a.emit('call:event', { roomId: 'r_forged', type: 'chat', payload: { text: 'x' } });
  a.emit('call:event', { roomId: aFound.roomId, type: 'evil', payload: { text: 'x' } });
  a.emit('call:event', { roomId: aFound.roomId, type: 'react', payload: { emoji: '🚀' } });
  await new Promise((r) => setTimeout(r, 400));
  if (!eventLeaked) pass('forged-room / unknown-type call:event dropped');
  else fail('forged call:event was relayed');

  // 8. hang up → partner notified, then a new match can be formed
  const leftPromise = waitFor(b, 'peer:left');
  a.emit('call:end');
  const left = await leftPromise;
  if (left.roomId === aFound.roomId && left.reason === 'ended')
    pass('partner notified on hang-up');
  else fail(`bad peer:left ${JSON.stringify(left)}`);

  // 9. B re-queues and gets a fresh partner (A re-queues too)
  const againA = waitFor(a, 'match:found');
  a.emit('queue:join', profileA);
  const againB = waitFor(b, 'match:found');
  b.emit('queue:join', profileB2);
  const [m1, m2] = await Promise.all([againA, againB]);
  if (m1.roomId === m2.roomId && m1.roomId !== aFound.roomId)
    pass('second match created after hang-up');
  else fail('could not re-match after hang-up');

  // 10. disconnect cleanup
  b.disconnect();
  const left2 = await waitFor(a, 'peer:left', 5000);
  if (left2.reason === 'disconnected') pass('partner notified on disconnect');
  else fail(`expected disconnected reason, got ${JSON.stringify(left2)}`);

  a.disconnect();

  const failures = results.filter((r) => r.startsWith('FAIL'));
  console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
  if (spawnedServer) spawnedServer.kill();
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('TEST CRASH:', err.message);
  if (spawnedServer) spawnedServer.kill();
  process.exit(1);
});
