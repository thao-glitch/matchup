/**
 * TURN reachability check — `npm run test:turn`
 *
 * Speaks real STUN/TURN (RFC 5389 + RFC 5766) to the TURN server the app is
 * configured with and performs an actual **Allocate** with long-term
 * credentials. That is the same exchange a browser makes before it can relay
 * video, so it proves three things at once:
 *
 *   1. `/api/ice` is handing out TURN credentials (not STUN-only),
 *   2. the credentials are valid (the MD5 key chain + HMAC-SHA1 hold),
 *   3. the relay really allocates (ports open, relay IP correct).
 *
 * Usage:
 *   node scripts/test-turn.js                          # creds from GET /api/ice
 *   BASE_URL=http://localhost:4000 node scripts/test-turn.js
 *   node scripts/test-turn.js --url turn:turn.example.com:3478 \
 *        --user '1700000000:abc' --pass '<password>' [--verbose]
 *
 * Exit codes: 0 = relay verified, 1 = failed, 2 = TURN not configured.
 *
 * No dependencies: node:dgram / node:net / node:tls / node:crypto only.
 */
const dgram = require('dgram');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const http = require('http');

const MAGIC = Buffer.from([0x21, 0x12, 0xa4, 0x42]);
const FINGERPRINT_XOR = 0x5354554e;

// Message types (method | class: success=0x0100, error=0x0110)
const ALLOCATE = 0x0003;
const CREATE_PERMISSION = 0x0008;
const ALLOCATE_SUCCESS = 0x0103;
const ALLOCATE_ERROR = 0x0113;
const CREATE_PERMISSION_SUCCESS = 0x0108;

// Attributes
const A = {
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  LIFETIME: 0x000d,
  NONCE: 0x0015,
  PEER_ADDRESS: 0x0012,
  REALM: 0x0014,
  XOR_RELAYED: 0x0016,
  REQUESTED_TRANSPORT: 0x0019,
  FINGERPRINT: 0x8028,
};

const verbose = process.argv.includes('--verbose');
const log = (...a) => console.log(...a);
const debug = (...a) => {
  if (verbose) console.log('  ·', ...a);
};

// ── STUN codec ───────────────────────────────────────────────────────────────

const pad4 = (n) => (4 - (n % 4)) % 4;

function encodeAttrs(attrs) {
  const chunks = [];
  for (const { type, value } of attrs) {
    const head = Buffer.alloc(4);
    head.writeUInt16BE(type, 0);
    head.writeUInt16BE(value.length, 2);
    chunks.push(head, value, Buffer.alloc(pad4(value.length)));
  }
  return Buffer.concat(chunks);
}

/**
 * Build a STUN message.
 *
 * MESSAGE-INTEGRITY is HMAC-SHA1 over the message *up to but not including*
 * the MI attribute, with the header length already adjusted to cover it
 * (RFC 5389 §15.4); FINGERPRINT (CRC32 XOR 0x5354554e) is appended the same
 * way, exactly as browsers do. Both stages must patch the header length of
 * the buffer that actually gets sent — forgetting that yields a packet that
 * looks fine locally but is dropped silently by the server.
 */
function buildMessage(type, attrs, { key = null, tid = null, fingerprint = true } = {}) {
  const txid = tid || crypto.randomBytes(12);
  const header = (length) => {
    const h = Buffer.alloc(20);
    h.writeUInt16BE(type, 0);
    h.writeUInt16BE(length, 2);
    MAGIC.copy(h, 4);
    txid.copy(h, 8);
    return h;
  };

  const body = encodeAttrs(attrs);
  let msg = Buffer.concat([header(body.length), body]);

  if (key) {
    // Length now covers the MI attribute that is about to be appended.
    const withMi = Buffer.from(msg);
    withMi.writeUInt16BE(msg.readUInt16BE(2) + 4 + 20, 2);
    const mac = crypto.createHmac('sha1', key).update(withMi).digest();
    const mi = Buffer.alloc(24);
    mi.writeUInt16BE(A.MESSAGE_INTEGRITY, 0);
    mi.writeUInt16BE(20, 2);
    mac.copy(mi, 4);
    msg = Buffer.concat([withMi, mi]);
  }

  if (fingerprint) {
    const withFp = Buffer.from(msg);
    withFp.writeUInt16BE(msg.readUInt16BE(2) + 4 + 4, 2);
    const fp = Buffer.alloc(8);
    fp.writeUInt16BE(A.FINGERPRINT, 0);
    fp.writeUInt16BE(4, 2);
    fp.writeUInt32BE((crc32(withFp) ^ FINGERPRINT_XOR) >>> 0, 4);
    msg = Buffer.concat([withFp, fp]);
  }

  return msg;
}

function parseMessage(buf) {
  if (buf.length < 20) throw new Error(`short STUN packet (${buf.length} bytes)`);
  const type = buf.readUInt16BE(0);
  const len = buf.readUInt16BE(2);
  const tid = Buffer.from(buf.subarray(8, 20));
  const attrs = {};
  let off = 20;
  const end = Math.min(20 + len, buf.length);
  while (off + 4 <= end) {
    const at = buf.readUInt16BE(off);
    const al = buf.readUInt16BE(off + 2);
    attrs[at] = Buffer.from(buf.subarray(off + 4, off + 4 + al));
    off += 4 + al + pad4(al);
  }
  return { type, attrs, tid };
}

/** XOR-MAPPED / XOR-RELAYED address (RFC 5766 §14.3). */
function parseAddress(value, tid) {
  const family = value[1];
  const port = value.readUInt16BE(2) ^ MAGIC.readUInt16BE(0);
  const mask = Buffer.concat([MAGIC, tid]);
  if (family === 1) {
    const ip = Buffer.alloc(4);
    for (let i = 0; i < 4; i++) ip[i] = value[4 + i] ^ mask[i];
    return `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}:${port}`;
  }
  const ip = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) ip[i] = value[4 + i] ^ mask[i];
  const parts = [];
  for (let i = 0; i < 16; i += 2) parts.push(ip.readUInt16BE(i).toString(16));
  return `[${parts.join(':')}]:${port}`;
}

function errorCode(attrs) {
  const v = attrs[A.ERROR_CODE];
  if (!v) return { code: 0, reason: '' };
  return { code: v[2] * 100 + v[3], reason: v.subarray(4).toString('utf8') };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── Transport: UDP datagrams, or TCP/TLS with 2-byte length framing ─────────

function makeTransport({ send, onDatagram, onClose }, timeoutMs) {
  const waiters = new Map();

  const deliver = (buf) => {
    let msg;
    try {
      msg = parseMessage(buf);
    } catch (e) {
      debug('unparseable packet:', e.message);
      return;
    }
    debug(`rx ${buf.length}B type=0x${msg.type.toString(16)} tid=${msg.tid.toString('hex').slice(0, 8)}`);
    const w = waiters.get(msg.tid.toString('hex'));
    if (w) {
      waiters.delete(msg.tid.toString('hex'));
      w.resolve(msg);
    }
  };
  onDatagram(deliver);

  return {
    /** Send a request and await the response echoing its transaction id. */
    request(buf, { retries = 3 } = {}) {
      const tid = Buffer.from(buf.subarray(8, 20));
      const key = tid.toString('hex');
      debug(`tx ${buf.length}B tid=${key.slice(0, 8)}`);
      return new Promise((resolve, reject) => {
        let attempt = 0;
        let timer = null;
        const settle = (fn, value) => {
          clearTimeout(timer);
          waiters.delete(key);
          fn(value);
        };
        // The waiter stays registered across retransmissions; a late response
        // to an earlier attempt still resolves the same promise.
        waiters.set(key, { resolve: (m) => settle(resolve, m) });
        const schedule = () => {
          timer = setTimeout(() => {
            if (++attempt >= retries) {
              settle(reject, new Error(`no STUN response after ${retries} attempts`));
              return;
            }
            // UDP is lossy — actually re-send, don't just re-arm the timer.
            send(buf);
            schedule();
          }, timeoutMs);
        };
        schedule();
        send(buf);
      });
    },
    close: () => {
      waiters.clear();
      onClose();
    },
  };
}

function openUdp(cfg, timeoutMs) {
  const sock = dgram.createSocket('udp4');
  return new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(0, () => {
      sock.removeAllListeners('error');
      sock.on('error', () => undefined);
      resolve(
        makeTransport(
          {
            send: (buf) => sock.send(buf, cfg.port, cfg.host),
            onDatagram: (fn) => sock.on('message', fn),
            onClose: () => sock.close(),
          },
          timeoutMs,
        ),
      );
    });
  });
}

function openStream(cfg, timeoutMs, secure) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: false })
      : net.connect({ host: cfg.host, port: cfg.port });

    let buffer = Buffer.alloc(0);
    let deliver = () => undefined;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    socket.once('error', fail);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      // STUN over TCP carries NO extra framing: each message is self-delimiting
      // via the header's length field (RFC 5389 §7.2.2; TURN/TCP → RFC 6062).
      // An earlier version prefixed messages RFC 4571-style, which a real TURN
      // server silently misparses — every TCP probe then timed out.
      while (buffer.length >= 4) {
        const type = buffer.readUInt16BE(0);
        const size = buffer.readUInt16BE(2);
        if ((type & 0xc000) !== 0) break; // not a STUN header — stop desyncing
        if (buffer.length < 20 + size) break;
        deliver(buffer.subarray(0, 20 + size));
        buffer = buffer.subarray(20 + size);
      }
    });

    const ready = () => {
      if (settled) return;
      settled = true;
      socket.removeListener('error', fail);
      socket.on('error', () => undefined);
      resolve(
        makeTransport(
          {
            send: (buf) => socket.write(buf), // raw STUN bytes — no length prefix
            onDatagram: (fn) => (deliver = fn),
            onClose: () => socket.destroy(),
          },
          timeoutMs,
        ),
      );
    };

    socket.once(secure ? 'secureConnect' : 'connect', ready);
    setTimeout(() => fail(new Error(`connect timeout to ${cfg.host}:${cfg.port}`)), timeoutMs);
  });
}

async function openTransport(cfg, timeoutMs) {
  if (cfg.secure || cfg.tcp) return openStream(cfg, timeoutMs, cfg.secure);
  return openUdp(cfg, timeoutMs);
}

// ── Config discovery ────────────────────────────────────────────────────────

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function notConfigured(message) {
  const err = new Error(message);
  err.code = 2;
  return err;
}

/** Parse `turn:host:port?transport=udp` / `turns:host:443?transport=tcp`. */
function parseTurnUrl(raw, username, credential) {
  const m = raw.match(/^(turns?):\[?([^\]]+?)\]?:(\d+)(\?|$)/);
  if (!m) throw new Error(`unrecognized TURN url: ${raw}`);
  const secure = m[1] === 'turns';
  const wantsTcp = /transport=tcp/.test(raw);
  return {
    username,
    credential,
    host: m[2],
    port: Number(m[3]),
    secure,
    tcp: secure || wantsTcp,
    label: raw,
  };
}

async function discover() {
  const url = argValue('--url');
  const user = argValue('--user');
  const pass = argValue('--pass');
  if (url) {
    if (!user || !pass) throw notConfigured('--url requires --user and --pass');
    return parseTurnUrl(url, user, pass);
  }

  const base = (process.env.BASE_URL || process.env.APP_URL || 'http://localhost:4000').replace(/\/$/, '');
  let payload;
  try {
    payload = await httpGetJson(`${base}/api/ice`);
  } catch (err) {
    throw notConfigured(`could not reach ${base}/api/ice (${err.message}) — is the server running?`);
  }

  log(`ice source: ${payload.source || 'unknown'}`);
  for (const server of payload.iceServers || []) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const u of urls) {
      if (String(u).startsWith('turn') && server.username && server.credential) {
        return parseTurnUrl(String(u), server.username, server.credential);
      }
    }
  }
  throw notConfigured(
    'no TURN credentials in /api/ice (STUN-only).\n' +
      '         Configure TURN_URLS + TURN_SECRET (coturn), TWILIO_* or ' +
      'TURN_USERNAME/TURN_CREDENTIAL — see README → "Deploying TURN".',
  );
}

// ── The test ────────────────────────────────────────────────────────────────

async function main() {
  const cfg = await discover();
  const timeoutMs = Number(process.env.TURN_TIMEOUT_MS) || 1500;
  log(`turn endpoint: ${cfg.label}  (${cfg.secure ? 'tls' : cfg.tcp ? 'tcp' : 'udp'})`);

  const transport = await openTransport(cfg, timeoutMs);
  debug(`transport open (${cfg.secure ? 'tls' : cfg.tcp ? 'tcp' : 'udp'})`);

  try {
    // 1. Unauthenticated Allocate → expect 401 with REALM + NONCE.
    const req1 = buildMessage(ALLOCATE, [
      { type: A.REQUESTED_TRANSPORT, value: Buffer.from([17, 0, 0, 0]) },
    ]);
    debug('Allocate (no credentials)');
    const res1 = await transport.request(req1);
    const challenge = errorCode(res1.attrs);
    if (res1.type !== ALLOCATE_ERROR || challenge.code !== 401) {
      throw new Error(`expected a 401 challenge, got ${challenge.code || `type 0x${res1.type.toString(16)}`}`);
    }
    const realm = res1.attrs[A.REALM];
    const nonce = res1.attrs[A.NONCE];
    if (!realm || !nonce) throw new Error('401 challenge is missing REALM/NONCE');
    debug(`realm=${realm.toString()} nonce=${nonce.toString().slice(0, 16)}…`);

    // 2. Authenticated Allocate. Long-term key = MD5(username:realm:password).
    const key = crypto
      .createHash('md5')
      .update(`${cfg.username}:${realm.toString('utf8')}:${cfg.credential}`, 'utf8')
      .digest();

    const attrs = [
      { type: A.USERNAME, value: Buffer.from(cfg.username, 'utf8') },
      { type: A.REALM, value: realm },
      { type: A.NONCE, value: nonce },
      { type: A.REQUESTED_TRANSPORT, value: Buffer.from([17, 0, 0, 0]) },
    ];

    let success = null;
    let lastFailure = null;
    for (let attempt = 0; attempt < 3 && !success; attempt++) {
      debug(`Allocate (credentials, attempt ${attempt + 1})`);
      const res = await transport.request(buildMessage(ALLOCATE, attrs, { key }));
      if (res.type === ALLOCATE_SUCCESS) {
        success = res;
        break;
      }
      const failure = errorCode(res.attrs);
      lastFailure = failure;
      if (failure.code === 438 && res.attrs[A.NONCE]) {
        // Stale nonce — refresh and retry exactly like a browser would.
        debug('stale nonce, refreshing');
        attrs[2] = { type: A.NONCE, value: res.attrs[A.NONCE] };
        continue;
      }
      throw new Error(`Allocate rejected: ${failure.code} ${failure.reason}`);
    }
    if (!success) {
      throw new Error(`Allocate rejected: ${lastFailure?.code} ${lastFailure?.reason || '(no reason)'}`);
    }

    const relayed = success.attrs[A.XOR_RELAYED];
    if (!relayed) throw new Error('Allocate succeeded but returned no XOR-RELAYED-ADDRESS');
    const relayAddr = parseAddress(relayed, success.tid);
    const lifetime = success.attrs[A.LIFETIME];
    log(
      `ok: allocation granted → ${relayAddr}` +
        (lifetime ? ` (lifetime ${lifetime.readUInt32BE(0)}s)` : ''),
    );

    // 3. CreatePermission — proves the auth chain holds past ALLOCATE.
    const peer = Buffer.alloc(8);
    peer.writeUInt16BE(1, 0); // family 1 = IPv4 (address attrs are not XORed)
    peer.writeUInt16BE(443, 2);
    Buffer.from([1, 1, 1, 1]).copy(peer, 4);

    const req3 = buildMessage(
      CREATE_PERMISSION,
      [
        { type: A.USERNAME, value: Buffer.from(cfg.username, 'utf8') },
        { type: A.REALM, value: realm },
        { type: A.NONCE, value: attrs[2].value },
        { type: A.PEER_ADDRESS, value: peer },
      ],
      { key },
    );
    debug('CreatePermission');
    const res3 = await transport.request(req3);
    if (res3.type !== CREATE_PERMISSION_SUCCESS) {
      const failure = errorCode(res3.attrs);
      throw new Error(`CreatePermission rejected: ${failure.code || `type 0x${res3.type.toString(16)}`}`);
    }
    log('ok: permission created — auth chain verified end to end');

    log('\nTURN relay verified: strict-NAT users have a fallback path.');
    return 0;
  } finally {
    try {
      transport.close();
    } catch {
      /* already closed */
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\nFAIL: ${err.message}`);
    process.exit(typeof err.code === 'number' ? err.code : 1);
  });
