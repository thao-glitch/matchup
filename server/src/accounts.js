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
  return {
    // Internal row id — the key the passport sync is stored under. Not a
    // secret (sessions are keyed by bearer-token hashes) and never used to
    // authorize anything on its own.
    id: account.id,
    username: account.username,
    profile: account.profile,
    createdAt: account.createdAt ? new Date(account.createdAt).toISOString() : null,
  };
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
async function register({ username, password, profile }) {
  const creds = normalizeCredentials(username, password);
  const clean = validateProfile({ ...(profile || {}), username: creds.username });
  if (!clean) {
    throw new AuthError('profile', 'That profile could not be validated — check your details.', 400);
  }

  const passwordHash = await hashPassword(creds.password);
  const account = await insertAccount(creds.username, passwordHash, clean);
  const token = await issueSession(account.id, account.username);
  return { token, user: toUser({ ...account, profile: clean }) };
}

/** Verify credentials and open a session. Same error for unknown user / bad password. */
async function login({ username, password }) {
  const creds = normalizeCredentials(username, password);
  const account = await lookupAccount(creds.username);
  const ok = await verifyPassword(creds.password, account?.passwordHash || DUMMY_HASH);
  if (!account || !ok) {
    throw new AuthError('credentials', 'Username or password is incorrect.', 401);
  }
  const token = await issueSession(account.id, account.username);
  if (backend === 'maria') mariaStore.touchAccount(account.id).catch(() => undefined);
  return { token, user: toUser(account) };
}

/** Resolve a bearer token to its user, or `null` when it is missing/expired. */
async function authenticate(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 128) return null;
  const hash = sha256(token);

  if (backend === 'maria') {
    try {
      const account = await mariaStore.findSession(hash);
      return account ? toUser(account) : null;
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
  init,
  register,
  login,
  authenticate,
  saveProfile,
  logout,
  backend: () => backend,
  /** Test seam: wipe the in-memory backend between suites. */
  _reset() {
    memoryAccounts.clear();
    memorySessions.clear();
  },
};
