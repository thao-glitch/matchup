/**
 * Admin side — authentication + the operations behind `/admin`.
 *
 * Security shape mirrors `accounts.js` on purpose, so there is exactly one
 * password implementation in this codebase:
 *   • scrypt (N=16384, r=8, p=1), 16-byte random salt;
 *   • `timingSafeEqual` against a dummy hash when no admin matched;
 *   • sessions are random 32-byte tokens, only their SHA-256 is stored;
 *   • 12-hour lifetime instead of 30 days — a stolen dashboard token is
 *     worthless by tomorrow, a stolen user token is not;
 *   • per-IP rate limit on `/api/admin/login` (wired in `server.js`);
 *   • every mutation is written to `audit_log`.
 *
 * Admins live in their own table (`admins`), never in `accounts`: being a user
 * of the app must never be able to become an admin of it.
 *
 * Bootstrap: when the table is empty, `ADMIN_USERNAME` + `ADMIN_PASSWORD` in
 * the environment create the first owner on boot. After that the environment
 * variables are ignored — the dashboard owns its own credentials from then on.
 */
const crypto = require('crypto');
const accounts = require('./accounts');
const mariaStore = require('./mariaStore');
const settings = require('./settings');
const telemetry = require('./telemetry');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const MIN_PASSWORD = 10;

const { AuthError, hashPassword, verifyPassword } = accounts;

/** `maria` = the dashboard works, `memory` = no database to hold admins. */
let backend = 'memory';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const DUMMY_HASH = `${'00'.repeat(16)}:${'00'.repeat(32)}`;

function init(storeMode) {
  backend = storeMode === 'maria' ? 'maria' : 'memory';
}

function requireDb() {
  if (backend !== 'maria') {
    throw new AuthError(
      'storage',
      'The dashboard needs the database — MARIADB_* is not configured on this server.',
      503,
    );
  }
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

/**
 * Create the first admin from the environment when none exists yet.
 * Safe to call on every boot: it does nothing once an admin row is present.
 * @returns {Promise<object|null>} the created admin, or null
 */
async function bootstrap(env = process.env) {
  if (backend !== 'maria') return null;
  const username = String(env.ADMIN_USERNAME || '').trim();
  const password = String(env.ADMIN_PASSWORD || '');
  if (!username || !password) return null;

  try {
    const existing = await mariaStore.countAdmins();
    if (existing > 0) return null;
    if (password.length < MIN_PASSWORD) {
      console.warn(
        `[admin] ADMIN_PASSWORD is shorter than ${MIN_PASSWORD} characters — first admin NOT created`,
      );
      return null;
    }
    const clean = String(username).trim().slice(0, 24);
    if (clean.length < 2) return null;
    const admin = await mariaStore.createAdmin({
      username: clean,
      passwordHash: await hashPassword(password),
      role: 'owner',
    });
    console.info(`[admin] first admin "${admin.username}" created from ADMIN_USERNAME/ADMIN_PASSWORD`);
    mariaStore.insertAudit({
      adminId: admin.id,
      adminName: admin.username,
      action: 'bootstrap',
      target: admin.username,
      detail: { via: 'environment' },
    });
    return admin;
  } catch (err) {
    console.error('[admin] bootstrap failed:', err.message);
    return null;
  }
}

// ── Auth ─────────────────────────────────────────────────────────────────────

/** POST /api/admin/login — same "one timing for every failure" rule as users. */
async function login({ username, password }) {
  requireDb();
  const name = String(username || '').trim().slice(0, 24);
  const secret = typeof password === 'string' ? password : '';
  if (name.length < 2 || !secret) {
    throw new AuthError('credentials', 'Enter your admin username and password.', 401);
  }

  const admin = await mariaStore.findAdmin(name);
  const ok = await verifyPassword(secret, admin?.passwordHash || DUMMY_HASH);
  if (!admin || !ok) {
    throw new AuthError('credentials', 'That username or password is incorrect.', 401);
  }

  const token = crypto.randomBytes(32).toString('base64url');
  try {
    await mariaStore.createAdminSession(sha256(token), admin.id, SESSION_TTL_MS);
  } catch (err) {
    console.error('[admin] session create failed:', err.message);
    throw new AuthError('storage', 'Could not start the session — try again shortly.', 503);
  }
  mariaStore.touchAdmin(admin.id);
  mariaStore.insertAudit({
    adminId: admin.id,
    adminName: admin.username,
    action: 'login',
    target: admin.username,
  });
  return { token, admin: { id: admin.id, username: admin.username, role: admin.role } };
}

/** Bearer token → admin, or null. Banned/unknown/expired all look the same. */
async function authenticate(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 128) return null;
  if (backend !== 'maria') return null;
  try {
    return await mariaStore.findAdminSession(sha256(token));
  } catch (err) {
    console.error('[admin] session lookup failed:', err.message);
    return null;
  }
}

async function logout(token) {
  if (typeof token !== 'string' || !token || backend !== 'maria') return;
  try {
    await mariaStore.deleteAdminSession(sha256(token));
  } catch (err) {
    console.error('[admin] logout failed:', err.message);
  }
}

/** Append one dashboard action to the audit trail. Never throws. */
function audit(admin, action, target = '', detail = null) {
  if (backend !== 'maria' || !admin) return;
  mariaStore.insertAudit({
    adminId: admin.id,
    adminName: admin.username,
    action,
    target: String(target),
    detail,
  });
}

// ── Operations ───────────────────────────────────────────────────────────────

/**
 * Everything the dashboard's front page shows, in one round-trip-free call:
 * database numbers, live matchmaking numbers, the call telemetry and the
 * payment ledger — all in the shape the React dashboard renders directly.
 */
async function overview(matchmaker) {
  requireDb();
  const [accounts_, payments, config] = await Promise.all([
    mariaStore.accountStats(),
    mariaStore.paymentSummary(),
    Promise.resolve(settings.get()),
  ]);

  return {
    accounts: accounts_,
    payments,
    live: matchmaker ? matchmaker.presence() : { online: 0, looking: 0 },
    calls: telemetry.snapshot(),
    store: { mode: backend },
    config: {
      features: { ...config.features },
      payment: { ...config.payment },
    },
    server: {
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      now: new Date().toISOString(),
    },
  };
}

// ── Users ────────────────────────────────────────────────────────────────────

async function listUsers(query) {
  requireDb();
  return mariaStore.listUsers(query);
}

/**
 * Ban / unban / grant premium on one account.
 * A ban also revokes their live sessions — `invalidateBanCache` makes the
 * matchmaker's `queue:join` check see it on the very next join.
 */
async function updateUser(admin, id, patch) {
  requireDb();
  const before = await mariaStore.getUser(id);
  if (!before) throw new AuthError('not-found', 'That account no longer exists.', 404);

  const user = await mariaStore.updateUserFlags(id, patch);
  if (!user) throw new AuthError('not-found', 'That account no longer exists.', 404);

  if (patch.banned === true) {
    await revokeSessions(user.id);
    accounts.invalidateBanCache(user.username);
    audit(admin, 'user.ban', `${user.username} (#${user.id})`, { ip: user.lastIp });
  } else if (patch.banned === false) {
    accounts.invalidateBanCache(user.username);
    audit(admin, 'user.unban', `${user.username} (#${user.id})`);
  }
  if (patch.premiumDays !== undefined) {
    audit(
      admin,
      patch.premiumDays === null ? 'user.premium.revoke' : 'user.premium.grant',
      `${user.username} (#${user.id})`,
      { days: patch.premiumDays ?? null, until: user.premiumUntil },
    );
  }
  return user;
}

/** Delete an account (sessions + passport cascade; payment rows survive). */
async function deleteUser(admin, id) {
  requireDb();
  const user = await mariaStore.getUser(id);
  if (!user) throw new AuthError('not-found', 'That account no longer exists.', 404);
  const removed = await mariaStore.deleteUser(id);
  if (!removed) throw new AuthError('not-found', 'That account no longer exists.', 404);
  accounts.invalidateBanCache(user.username);
  audit(admin, 'user.delete', `${user.username} (#${user.id})`);
  return user;
}

/** Drop every live session of one account — a ban takes effect immediately. */
async function revokeSessions(accountId) {
  try {
    await mariaStore.deleteSessionsForAccount(accountId);
  } catch (err) {
    console.error('[admin] revoke sessions failed:', err.message);
  }
}

// ── Payments ─────────────────────────────────────────────────────────────────

async function listPayments(query) {
  requireDb();
  return mariaStore.listPayments(query);
}

/**
 * Approve / reject one ledger row. Approving is the moment premium is
 * granted (see `mariaStore.reviewPayment`) — this is the manual step that
 * replaces the callback a paybill does not send.
 */
async function reviewPayment(admin, id, patch = {}) {
  requireDb();
  const status = String(patch.status || '');
  if (!['pending', 'approved', 'rejected'].includes(status)) {
    throw new AuthError('status', 'Status must be pending, approved or rejected.', 400);
  }
  const before = await mariaStore.getPayment(id);
  if (!before) throw new AuthError('not-found', 'That payment no longer exists.', 404);

  const payment = await mariaStore.reviewPayment(id, {
    status,
    note: patch.note ?? before.note,
    adminId: admin.id,
  });
  audit(admin, `payment.${status}`, `#${payment.id} ${payment.username}`, {
    amount: payment.amount,
    currency: payment.currency,
    accountNo: payment.accountNo,
    providerRef: payment.providerRef,
  });
  return payment;
}

// ── Settings ─────────────────────────────────────────────────────────────────

async function getSettings() {
  requireDb();
  if (!settings.isLoaded()) await settings.load();
  return settings.get();
}

async function saveSettings(admin, patch) {
  requireDb();
  const next = await settings.save(patch);
  audit(admin, 'settings.update', '', {
    payment: patch.payment ? Object.keys(patch.payment) : null,
    features: patch.features ? Object.keys(patch.features) : null,
  });
  return next;
}

async function listAudit(limit) {
  requireDb();
  return mariaStore.listAudit(limit);
}

module.exports = {
  AuthError,
  init,
  bootstrap,
  login,
  authenticate,
  logout,
  audit,
  overview,
  listUsers,
  updateUser,
  deleteUser,
  listPayments,
  reviewPayment,
  getSettings,
  saveSettings,
  listAudit,
  backend: () => backend,
};
