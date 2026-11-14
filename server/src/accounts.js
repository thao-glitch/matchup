/**
 * Accounts: username + password, so a returning visitor keeps their profile
 * and can change any preference at any time.
 *
 * Backends (chosen from the store mode at boot):
 *   • `maria`  → the local MariaDB (`accounts` / `account_sessions` tables).
 *   • anything else → an in-process Map, so dev / MongoDB setups still work
 *     (accounts then vanish on restart — `server.js` logs this at startup).
 *
 * Security shape:
 *   • scrypt (N=16384, r=8, p=1) with a 16-byte random salt — no new
 *     dependency, and slow enough to make offline cracking expensive.
 *   • verification is `timingSafeEqual` against a dummy hash when the user
 *     does not exist, so "no such user" and "wrong password" take the same
 *     time and cannot be told apart.
 *   • sessions are random 32-byte bearer tokens; only their SHA-256 is stored,
 *     so the database never contains anything that can be replayed.
 *   • usernames are compared case-insensitively (the MariaDB unique index is
 *     `_ci`), so `Alice` and `alice` are the same account.
 */
const crypto = require('crypto');
const { promisify } = require('util');
const { validateProfile, sanitizeUsername } = require('./matchmaking');
const mariaStore = require('./mariaStore');

const scrypt = promisify(crypto.scrypt);

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

/** `maria` = real database, `memory` = process-local (dev / mongo fallback). */
let backend = 'memory';

/** lowercased username -> account (memory backend) */
const memoryAccounts = new Map();
/** token hash -> { username, expiresAt } (memory backend) */
const memorySessions = new Map();

/** Hash shape `salt:hash` used to burn a verification when no user matched. */
const DUMMY_HASH = `${'00'.repeat(16)}:${'00'.repeat(KEYLEN)}`;

class AuthError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

/** Wire the backend to whatever store came up during boot. */
function init(storeMode) {
  backend = storeMode === 'maria' ? 'maria' : 'memory';
  if (backend === 'memory' && storeMode === 'mongo') {
    console.warn(
      '[auth] MongoDB has no account backend yet — accounts are kept in memory and will not survive a restart',
    );
  }
}

// ── Password hashing ────────────────────────────────────────────────────────

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, KEYLEN, SCRYPT);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [saltHex, keyHex] = String(stored || '').split(':');
  if (!saltHex || !keyHex) return false;
  let derived;
  try {
    derived = await scrypt(String(password), Buffer.from(saltHex, 'hex'), KEYLEN, SCRYPT);
  } catch {
    return false;
  }
  const expected = Buffer.from(keyHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// ── Validation ──────────────────────────────────────────────────────────────

function normalizeCredentials(rawUsername, rawPassword) {
  const username = sanitizeUsername(rawUsername || '');
  if (username.length < 2) {
    throw new AuthError('username', 'Pick a username with at least 2 characters.', 400);
  }
  const password = typeof rawPassword === 'string' ? rawPassword : '';
  if (password.length < MIN_PASSWORD) {
    throw new AuthError('password', `Password must be at least ${MIN_PASSWORD} characters.`, 400);
  }
  if (password.length > MAX_PASSWORD) {
    throw new AuthError('password', 'Password must be 128 characters or fewer.', 400);
  }
  return { username, password };
}

function toUser(account) {
  const username = account.username;
  return {
    // Internal row id — the key the passport sync is stored under. Not a
    // secret (sessions are keyed by bearer-token hashes) and never used to
    // authorize anything on its own.
    id: account.id,
    username,
    profile: account.profile,
    createdAt: account.createdAt ? new Date(account.createdAt).toISOString() : null,
    // Paybill entitlement: ISO timestamp or null. Purely informational for
    // the client — the server is what decides whether premium applies.
    premiumUntil: account.premiumUntil ? new Date(account.premiumUntil).toISOString() : null,
    // Profile photos are public assets served by the app (never the object
    // store directly), so a missing photo is a plain null the UI renders as
    // the username's first letter.
    avatarUrl: account.avatarKey ? photoUrl(username, 'avatar') : null,
    bannerUrl: account.bannerKey ? photoUrl(username, 'banner') : null,
    // The raw keys are only used by the photo routes to delete a replaced
    // file; clients are handed the URLs above and never the storage path.
    avatarKey: account.avatarKey || null,
    bannerKey: account.bannerKey || null,
  };
}

/** Public URL for one profile photo — shared by the account, creator and
 * admin surfaces so every avatar on the site resolves the same way. */
function photoUrl(username, kind) {
  return `/api/profile/${encodeURIComponent(String(username || ''))}/photo/${kind === 'banner' ? 'banner' : 'avatar'}`;
}

// ── Storage helpers (both backends return the same shapes) ──────────────────

async function insertAccount(username, passwordHash, profile) {
  if (backend === 'maria') {
    try {
      return await mariaStore.createAccount({ username, passwordHash, profile });
    } catch (err) {
      if (err.code === 'DUPLICATE') {
        throw new AuthError(
          'username-taken',
          'That username is already taken — try signing in instead.',
          409,
        );
      }
      console.error('[auth] register failed:', err.message);
      throw new AuthError('storage', 'Accounts are unavailable right now — try again shortly.', 503);
    }
  }

  const key = username.toLowerCase();
  if (memoryAccounts.has(key)) {
    throw new AuthError(
      'username-taken',
      'That username is already taken — try signing in instead.',
      409,
    );
  }
  const account = { id: memoryAccounts.size + 1, username, passwordHash, profile, createdAt: new Date() };
  memoryAccounts.set(key, account);
  return account;
}

async function lookupAccount(username) {
  if (backend === 'maria') return mariaStore.findAccount(username);
  return memoryAccounts.get(username.toLowerCase()) || null;
}

async function persistProfile(username, profile) {
  if (backend === 'maria') {
    try {
      return await mariaStore.updateAccountProfile(username, profile);
    } catch (err) {
      if (err.code === 'DUPLICATE') {
        throw new AuthError('username-taken', 'That username is already taken.', 409);
      }
      console.error('[auth] profile save failed:', err.message);
      throw new AuthError('storage', 'Could not save your profile — try again shortly.', 503);
    }
  }
  const account = memoryAccounts.get(username.toLowerCase());
  if (!account) return null;
  account.profile = profile;
  return account;
}

async function issueSession(accountId, username) {
  // 32 random bytes → ~43 URL-safe chars; only the hash is stored.
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = sha256(token);
  if (backend === 'maria') {
    try {
      await mariaStore.createSession(hash, accountId, SESSION_TTL_MS);
      mariaStore.touchAccount(accountId);
    } catch (err) {
      console.error('[auth] session create failed:', err.message);
      throw new AuthError('storage', 'Could not start your session — try again shortly.', 503);
    }
  } else {
    memorySessions.set(hash, { username, expiresAt: Date.now() + SESSION_TTL_MS });
  }
  return token;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Create an account + first session. The profile is validated here, not trusted. */
async function register({ username, password, profile, ip }) {
  const creds = normalizeCredentials(username, password);
  const clean = validateProfile({ ...(profile || {}), username: creds.username });
  if (!clean) {
    throw new AuthError('profile', 'That profile could not be validated — check your details.', 400);
  }

  const passwordHash = await hashPassword(creds.password);
  const account = await insertAccount(creds.username, passwordHash, clean);
  if (backend === 'maria' && ip) mariaStore.recordAccountIp(account.id, ip);
  const token = await issueSession(account.id, account.username);
  return { token, user: toUser({ ...account, profile: clean }) };
}

/** Verify credentials and open a session. Same error for unknown user / bad password. */
async function login({ username, password, ip }) {
  const creds = normalizeCredentials(username, password);
  const account = await lookupAccount(creds.username);
  const ok = await verifyPassword(creds.password, account?.passwordHash || DUMMY_HASH);
  if (!account || !ok) {
    throw new AuthError('credentials', 'Username or password is incorrect.', 401);
  }
  // Suspended accounts authenticate nowhere: the password check above still
  // runs in full, so this cannot be used to probe for banned usernames.
  if (account.banned) {
    throw new AuthError(
      'banned',
      'This account has been suspended. Contact support if you think this is a mistake.',
      403,
    );
  }
  const token = await issueSession(account.id, account.username);
  if (backend === 'maria') {
    mariaStore.touchAccount(account.id).catch(() => undefined);
    if (ip) mariaStore.recordAccountIp(account.id, ip);
  }
  return { token, user: toUser(account) };
}

/**
 * Is this username suspended? Answers from a 30s cache so the matchmaker can
 * ask on every `queue:join` without a round-trip per queueing user.
 * `null` (unknown / no database) always means "not banned".
 */
let banCache = { at: 0, map: new Map() };
async function isBanned(username) {
  const key = String(username || '').toLowerCase();
  if (!key || backend !== 'maria') return false;
  const now = Date.now();
  if (now - banCache.at > 30_000) {
    banCache = { at: now, map: new Map() };
  }
  if (banCache.map.has(key)) return banCache.map.get(key);
  try {
    const row = await mariaStore.findAccountByUsername(username);
    const banned = Boolean(row && row.banned);
    banCache.map.set(key, banned);
    return banned;
  } catch {
    // The database is down: never lock everyone out of the queue over it.
    return false;
  }
}

/** Called after a dashboard ban/unban so the cache above cannot go stale. */
function invalidateBanCache(username) {
  const key = String(username || '').toLowerCase();
  banCache.at = 0;
  if (key) banCache.map.delete(key);
}

// ── Ban enforcement across the whole app ─────────────────────────────────────

/**
 * Addresses a suspended account last signed in from. A ban that only knows
 * usernames is trivially sidestepped by picking a new one, so the matchmaker
 * also refuses `queue:join` from any socket on a banned address. Refreshed at
 * boot and on every ban/unban; an empty set simply means "no bans to honour".
 */
let bannedIps = new Set();

async function refreshBanIps() {
  if (backend !== 'maria') return bannedIps;
  try {
    const rows = await mariaStore.loadBannedIps();
    bannedIps = new Set(rows.map((r) => r.ip).filter(Boolean));
  } catch (err) {
    // Keep whatever we had: a database blip must not un-ban the world.
    console.error('[auth] ban IP refresh failed:', err.message);
  }
  return bannedIps;
}

function ipBanned(ip) {
  return Boolean(ip) && bannedIps.has(String(ip));
}

/** username -> { id, at } so a queue join costs at most one lookup per minute. */
const idCache = new Map();
const ID_CACHE_TTL_MS = 60_000;

/**
 * Record the address someone is currently queueing from against their account.
 * Fire-and-forget and best effort: matchmaking must never wait on it, and a
 * database that is down simply means the ban list stays as accurate as it was.
 */
function noteQueueIp(username, ip) {
  if (backend !== 'maria' || !ip || !username) return;
  const key = String(username).toLowerCase();
  const now = Date.now();
  const cached = idCache.get(key);
  if (cached && now - cached.at < ID_CACHE_TTL_MS) return;
  idCache.set(key, { id: cached?.id ?? null, at: now });

  const apply = (id) => {
    if (!id) return;
    idCache.set(key, { id, at: now });
    mariaStore.recordAccountIp(id, ip);
  };

  if (cached?.id) {
    apply(cached.id);
    return;
  }
  mariaStore
    .findAccountByUsername(username)
    .then((row) => apply(row?.id ?? null))
    .catch(() => undefined);
}

/** Resolve a bearer token to its user, or `null` when it is missing/expired. */
async function authenticate(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 128) return null;
  const hash = sha256(token);

  if (backend === 'maria') {
    try {
      const account = await mariaStore.findSession(hash);
      if (!account) return null;
      if (account.banned) {
        // A ban revokes access immediately, not at the next password login:
        // drop the live session so the very next request fails closed.
        await mariaStore.deleteSession(hash).catch(() => undefined);
        return null;
      }
      return toUser(account);
    } catch (err) {
      console.error('[auth] session lookup failed:', err.message);
      return null;
    }
  }

  const session = memorySessions.get(hash);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    memorySessions.delete(hash);
    return null;
  }
  const account = memoryAccounts.get(session.username.toLowerCase());
  return account ? toUser(account) : null;
}

/**
 * Save the user's (freely editable) profile — every field may change:
 * username, age, gender, country and both preference controls.
 * A renamed username must still be unique.
 */
async function saveProfile(token, profile) {
  const current = await authenticate(token);
  if (!current) throw new AuthError('unauthorized', 'Please sign in again.', 401);

  const clean = validateProfile(profile);
  if (!clean) throw new AuthError('profile', 'That profile could not be validated.', 400);

  if (clean.username.toLowerCase() !== current.username.toLowerCase()) {
    const clash = await lookupAccount(clean.username);
    if (clash) {
      throw new AuthError('username-taken', 'That username is already taken.', 409);
    }
  }

  const previousName = current.username;
  const updated = await persistProfile(previousName, clean);
  if (!updated) throw new AuthError('unauthorized', 'Please sign in again.', 401);

  // Username changed → rename the account row / memory key as well.
  if (clean.username !== previousName && backend === 'memory') {
    const account = memoryAccounts.get(previousName.toLowerCase());
    if (account) {
      memoryAccounts.delete(previousName.toLowerCase());
      account.username = clean.username;
      account.profile = clean;
      memoryAccounts.set(clean.username.toLowerCase(), account);
    }
  }

  return { user: toUser({ ...updated, username: clean.username, profile: clean }) };
}

/** Drop the session. Never throws — a logout should always succeed client-side. */
async function logout(token) {
  if (typeof token !== 'string' || !token) return;
  const hash = sha256(token);
  try {
    if (backend === 'maria') await mariaStore.deleteSession(hash);
    else memorySessions.delete(hash);
  } catch (err) {
    console.error('[auth] logout failed:', err.message);
  }
}

module.exports = {
  AuthError,
  photoUrl,
  init,
  register,
  login,
  authenticate,
  saveProfile,
  logout,
  // Shared with `admin.js`: the dashboard hashes with the exact same scrypt
  // parameters, so there is one password implementation in the codebase.
  hashPassword,
  verifyPassword,
  isBanned,
  invalidateBanCache,
  refreshBanIps,
  ipBanned,
  noteQueueIp,
  backend: () => backend,
  /** Test seam: wipe the in-memory backend between suites. */
  _reset() {
    memoryAccounts.clear();
    memorySessions.clear();
  },
};
