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
const socialStore = require('./socialStore');
const settings = require('./settings');
const telemetry = require('./telemetry');
const commerce = require('./commerce');
const mpesa = require('./mpesa');

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
 * database numbers, live matchmaking numbers, the call telemetry, the payment
 * ledger and the social platform's money — all in the shape the React
 * dashboard renders directly.
 */
async function overview(matchmaker, roomHub) {
  requireDb();
  const [accounts_, payments, config, charges, wallets, rooms_] = await Promise.all([
    mariaStore.accountStats(),
    mariaStore.paymentSummary(),
    Promise.resolve(settings.get()),
    socialStore.chargeSummary({ days: 14 }).catch(() => null),
    socialStore.walletStats().catch(() => null),
    socialStore.roomStats().catch(() => null),
  ]);

  return {
    accounts: accounts_,
    payments,
    live: matchmaker ? matchmaker.presence() : { online: 0, looking: 0 },
    calls: telemetry.snapshot(),
    // The new money: what came in, what the house kept, what is held in wallets.
    commerce: {
      charges: charges ?? { count: 0, gross: 0, commission: 0, net: 0, pending: 0, paid: 0, byDay: [] },
      wallets: wallets ?? { held: 0, earned: 0, paidOut: 0, wallets: 0, pendingPayouts: 0, pendingAmount: 0 },
      rooms: { ...(rooms_ ?? { live: 0, total: 0 }), ...(roomHub ? roomHub.stats() : {}) },
    },
    store: { mode: backend },
    config: {
      features: { ...config.features },
      payment: { ...config.payment },
      commerce: { ...config.commerce },
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
  // Masked view: the Daraja secrets come back as `••••` (and a write of a
  // still-masked value is ignored), so the dashboard can round-trip a save
  // without ever displaying a key.
  return settings.adminView();
}

async function saveSettings(admin, patch) {
  requireDb();
  const next = await settings.save(patch);
  // A rotated Daraja key must take effect on the very next push.
  if (patch.mpesa !== undefined) mpesa.invalidateToken();
  audit(admin, 'settings.update', '', {
    payment: patch.payment ? Object.keys(patch.payment) : null,
    features: patch.features ? Object.keys(patch.features) : null,
    commerce: patch.commerce ? Object.keys(patch.commerce) : null,
    mpesa: patch.mpesa ? Object.keys(patch.mpesa) : null,
  });
  return next;
}

async function listAudit(limit) {
  requireDb();
  return mariaStore.listAudit(limit);
}

// ── Content (posts) ──────────────────────────────────────────────────────────

async function listPosts(query) {
  requireDb();
  return socialStore.listPosts({
    page: query.page,
    size: query.size,
    q: query.q,
    adult: true, // the dashboard sees everything, including the adult shelf
    creatorId: query.creatorId || null,
    status: query.status || 'all',
  });
}

/** Hide / restore / delete a post. Every branch lands in the audit trail. */
async function moderatePost(admin, id, patch = {}) {
  requireDb();
  const before = await socialStore.getPost(id, { withCountry: false });
  if (!before) throw new AuthError('not-found', 'That post no longer exists.', 404);

  const status = patch.status;
  if (['active', 'hidden', 'removed'].includes(status)) {
    if (status === 'removed') {
      await socialStore.deletePost(id);
      audit(admin, 'post.delete', `#${id} @${before.creatorName}`, {
        price: before.price,
        isAdult: before.isAdult,
        reason: patch.note ?? null,
      });
      return { post: { ...before, status: 'removed' } };
    }
    const post = await socialStore.updatePostStatus(id, status);
    audit(admin, status === 'hidden' ? 'post.hide' : 'post.restore', `#${id} @${before.creatorName}`, {
      reason: patch.note ?? null,
    });
    return { post };
  }
  if (typeof patch.deleteComments === 'boolean' && patch.deleteComments) {
    await mariaStore.query(
      "UPDATE post_comments SET status = 'removed' WHERE post_id = ?",
      [Number(id)],
    );
    audit(admin, 'post.comments.purge', `#${id}`);
    return { post: before };
  }
  throw new AuthError('status', 'Status must be active, hidden or removed.', 400);
}

// ── Charges (the new payment ledger) ────────────────────────────────────────

async function listCharges(query) {
  requireDb();
  return socialStore.listCharges(query);
}

/**
 * Manual settlement — the `manual` payment mode's "the money is on the
 * statement, open the gate" button. `settle()` is idempotent, so a click that
 * races the real M-PESA callback cannot pay a creator twice.
 */
async function reviewCharge(admin, id, patch = {}) {
  requireDb();
  const before = await socialStore.getCharge(id);
  if (!before) throw new AuthError('not-found', 'That payment no longer exists.', 404);

  if (patch.status === 'paid') {
    const settled = await commerce.settle(id, {
      receipt: patch.mpesaRef ?? before.mpesaRef,
      description: patch.note ?? 'Approved by owner',
    });
    audit(admin, 'charge.approve', `#${id} ${before.buyerUsername} → ${before.payeeUsername}`, {
      amount: before.amount,
      commission: before.commission,
      net: before.net,
      purpose: before.purpose,
      alreadySettled: !settled,
    });
    return socialStore.getCharge(id);
  }
  if (patch.status === 'failed') {
    await commerce.fail(id, { description: patch.note ?? 'Rejected by owner', note: 'manual review' });
    audit(admin, 'charge.reject', `#${id} ${before.buyerUsername}`, {
      amount: before.amount,
      reason: patch.note ?? null,
    });
    return socialStore.getCharge(id);
  }
  throw new AuthError('status', 'Status must be paid or failed.', 400);
}

// ── Rooms ────────────────────────────────────────────────────────────────────

async function listRooms(query) {
  requireDb();
  const result = await socialStore.listRooms({
    kind: query.kind || '',
    status: query.status === 'all' ? '' : query.status || 'live',
    adult: null,
    page: query.page,
    size: query.size,
  });
  return result;
}

/**
 * Close or reopen a room. Closing while people are inside has to reach the
 * live sockets, so the route passes the hub in — `admin.js` never imports it
 * (the hub is constructed in `server.js` after the store is up).
 */
async function updateRoom(admin, id, patch = {}, roomHub = null) {
  requireDb();
  const before = await socialStore.getRoomById(id);
  if (!before) throw new AuthError('not-found', 'That room no longer exists.', 404);
  const status = patch.status === 'live' ? 'live' : patch.status === 'ended' ? 'ended' : null;
  if (!status) throw new AuthError('status', 'Status must be live or ended.', 400);

  if (status === 'ended' && roomHub) {
    await roomHub.close(before.slug, { admin: true });
  } else {
    await socialStore.setRoomStatus(id, status);
  }
  audit(admin, `room.${status}`, `${before.slug} "${before.title}"`, {
    host: before.hostName,
    price: before.price,
    isAdult: before.isAdult,
  });
  return socialStore.getRoomById(id);
}

// ── Earnings / wallets ───────────────────────────────────────────────────────

async function earnings({ days = 30 } = {}) {
  requireDb();
  const [charges, wallets, withdrawals] = await Promise.all([
    socialStore.chargeSummary({ days }),
    socialStore.walletStats(),
    socialStore.listWalletEntries({ status: 'pending', size: 50 }),
  ]);
  return { ...charges, wallets, withdrawals: withdrawals.items };
}

async function listWallets(query) {
  requireDb();
  return socialStore.listWallets(query);
}

async function adjustWallet(admin, accountId, amount, memo) {
  requireDb();
  try {
    const wallet = await socialStore.adjustWallet(accountId, amount, memo);
    audit(admin, 'wallet.adjust', `#${accountId}`, { amount: Number(amount), memo: memo ?? null });
    return { wallet };
  } catch (err) {
    if (err.code === 'INSUFFICIENT') {
      throw new AuthError('insufficient', err.message, 400);
    }
    throw new AuthError('amount', 'Enter an amount to adjust.', 400);
  }
}

/** Approve (money out) or reject (refunded) a pending creator payout. */
async function settlePayout(admin, id, patch = {}) {
  requireDb();
  const status = patch.status === 'approved' ? 'approved' : patch.status === 'rejected' ? 'rejected' : null;
  if (!status) throw new AuthError('status', 'Status must be approved or rejected.', 400);
  const entry = await socialStore.settleWithdrawal(id, status);
  if (!entry) {
    throw new AuthError('not-found', 'That payout has already been processed.', 409);
  }
  audit(admin, `payout.${status}`, `#${id}`, { amount: entry.amount });
  return { entry };
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
  // Social platform
  listPosts,
  moderatePost,
  listCharges,
  reviewCharge,
  listRooms,
  updateRoom,
  earnings,
  listWallets,
  adjustWallet,
  settlePayout,
  backend: () => backend,
};
