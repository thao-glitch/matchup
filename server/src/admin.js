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
const mediaStore = require('./mediaStore');
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

/** snake_case subscription row → camelCase, tolerating DECIMAL-as-string. */
function mapSubscription(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    subscriberId: Number(row.subscriber_id),
    creatorId: Number(row.creator_id),
    otherUsername: row.other_username || '',
    status: row.status,
    price: Number(row.price) || 0,
    currency: row.currency || 'KES',
    periodDays: Number(row.period_days) || 30,
    startedAt: row.started_at || null,
    expiresAt: row.expires_at || null,
    canceledAt: row.canceled_at || null,
  };
}

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

/**
 * One-time credential rotation for a lost admin password.
 *
 * Hosted environments store `ADMIN_PASSWORD` and the database password as
 * write-only secrets, so neither can be read back from a laptop. When
 * `ADMIN_RESET_PASSWORD` is present this runs on boot, rewrites the hash for
 * `ADMIN_RESET_USERNAME` (default: `ADMIN_USERNAME`, else `owner`), invalidates
 * that admin's sessions and writes an audit row. Remove the variable and
 * redeploy once the new password has been verified.
 *
 * Safe to leave configured: every boot simply sets the same hash again.
 */
async function resetFromEnv(env = process.env) {
  if (backend !== 'maria') return null;
  const password = String(env.ADMIN_RESET_PASSWORD || '');
  if (!password) return null;
  if (password.length < MIN_PASSWORD) {
    console.warn(
      `[admin] ADMIN_RESET_PASSWORD is shorter than ${MIN_PASSWORD} characters — reset skipped`,
    );
    return null;
  }
  const username = String(env.ADMIN_RESET_USERNAME || env.ADMIN_USERNAME || 'owner')
    .trim()
    .slice(0, 24);
  if (username.length < 2) return null;

  try {
    let admin = await mariaStore.findAdmin(username);
    if (!admin) {
      admin = await mariaStore.createAdmin({
        username,
        passwordHash: await hashPassword(password),
        role: 'owner',
      });
      console.info(`[admin] created "${admin.username}" from ADMIN_RESET_PASSWORD`);
    } else {
      await mariaStore.query('UPDATE admins SET password_hash = ? WHERE id = ?', [
        await hashPassword(password),
        admin.id,
      ]);
      await mariaStore.query('DELETE FROM admin_sessions WHERE admin_id = ?', [admin.id]);
      console.info(`[admin] password reset for "${admin.username}" from ADMIN_RESET_PASSWORD`);
    }
    mariaStore.insertAudit({
      adminId: admin.id,
      adminName: admin.username,
      action: 'password.reset',
      target: admin.username,
      detail: { via: 'environment' },
    });
    return admin;
  } catch (err) {
    console.error('[admin] password reset failed:', err.message);
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
  const [accounts_, payments, config, charges, wallets, rooms_, live, liveRooms, database] =
    await Promise.all([
      mariaStore.accountStats(),
      mariaStore.paymentSummary(),
      Promise.resolve(settings.get()),
      socialStore.chargeSummary({ days: 14 }).catch(() => null),
      socialStore.walletStats().catch(() => null),
      socialStore.roomStats().catch(() => null),
      // The realtime facade answers over HTTP now — every method is async.
      (matchmaker ? matchmaker.presence() : Promise.resolve(null)).catch(() => null),
      (roomHub ? roomHub.stats() : Promise.resolve(null)).catch(() => null),
      mariaStore.dbStats().catch(() => null),
    ]);

  return {
    accounts: accounts_,
    payments,
    live: live || { online: 0, looking: 0 },
    calls: telemetry.snapshot(),
    // The new money: what came in, what the house kept, what is held in wallets.
    commerce: {
      charges: charges ?? { count: 0, gross: 0, commission: 0, net: 0, pending: 0, paid: 0, byDay: [] },
      wallets: wallets ?? { held: 0, earned: 0, paidOut: 0, wallets: 0, pendingPayouts: 0, pendingAmount: 0 },
      rooms: { ...(rooms_ ?? { live: 0, total: 0 }), ...(liveRooms || { rooms: 0, participants: 0 }) },
    },
    store: { mode: backend },
    database,
    media: mediaStore.describe(),
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

/** Database footprint + connection headroom for the overview card. */
async function databaseStats() {
  requireDb();
  return mariaStore.dbStats();
}

/** Run the object-storage/DB media lifecycle sweep from the dashboard. */
async function pruneMedia(admin, opts = {}) {
  requireDb();
  const result = await commerce.pruneMedia({ dryRun: Boolean(opts.dryRun) });
  audit(admin, 'media.prune', result.dryRun ? 'dry-run' : 'live', {
    blobDeleted: result.blob.deleted,
    dbDeleted: result.database.deleted,
    localDeleted: result.local.deleted,
    referencedKeys: result.referencedKeys,
  });
  return result;
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
    await accounts.refreshBanIps();
    audit(admin, 'user.ban', `${user.username} (#${user.id})`, { ip: user.lastIp });
  } else if (patch.banned === false) {
    accounts.invalidateBanCache(user.username);
    await accounts.refreshBanIps();
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

// ── M-PESA ───────────────────────────────────────────────────────────────────

/**
 * Check the Daraja setup end to end and report what is outstanding.
 *
 * This replaced the old payments approval screen: there is nothing left for
 * the owner to approve, because the callback settles every charge. What the
 * owner does need is a way to tell "my credentials are wrong" from "my
 * shortcode is missing" without reading a stack trace.
 */
async function testMpesa(admin, body = {}) {
  const phone = body?.phone ? String(body.phone).trim() : '';
  const result = await mpesa.testConnection({ phone });
  audit(admin, 'mpesa.test', phone || 'config only', {
    ok: result.ok,
    failed: result.checks.filter((check) => check.ok === false).map((check) => check.name),
  });
  return result;
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
    // `''` (the dashboard's "All") must mean every status, not the feed default.
    status: query.status && query.status !== '' ? query.status : 'all',
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
 * Manual settlement — the fallback for a charge whose callback never landed
 * (a dead tunnel, a dropped poll). `settle()` is idempotent, so a click that
 * races the real M-PESA callback cannot pay a creator — or extend a premium —
 * twice. Premium charges settle onto the buyer's account here too.
 */
async function reviewCharge(admin, id, patch = {}) {
  requireDb();
  const before = await socialStore.getCharge(id);
  if (!before) throw new AuthError('not-found', 'That payment no longer exists.', 404);

  if (patch.status === 'paid') {
    const settled = await commerce.settle(id, {
      receipt: patch.mpesaRef ?? before.mpesaRef,
      note: patch.note ?? 'Approved by owner',
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
    // `''` is the dashboard's "All" — an empty filter must not silently
    // fall back to live-only results.
    status: query.status === 'all' || query.status === '' ? '' : query.status || 'live',
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

// ── Supervision: everything one account touches ─────────────────────────────

/**
 * The owner's supervision surface — one account and every row it owns, in a
 * single round trip:
 *
 *   profile + photos → posts (all statuses, paid and adult included),
 *   comments, likes, follows both ways, subscriptions bought and sold plus
 *   this account's own offer, every charge as buyer and as payee, wallet and
 *   its entries, live session count, passport stamps, rooms hosted and the
 *   live room roster.
 *
 * Reads stay on the primary: an admin inspecting a live account must never
 * be shown replica lag. Nothing here is filtered for privacy — that is the
 * point of the screen — but every call is logged in `audit_log`.
 */
async function accountDetail(admin, id) {
  requireDb();
  const uid = Number(id);
  const account = await mariaStore.getUser(uid);
  if (!account) throw new AuthError('not-found', 'That account does not exist.', 404);

  const [
    posts,
    comments,
    likes,
    following,
    followers,
    subsBought,
    subsSold,
    offer,
    chargesBought,
    chargesEarned,
    wallet,
    walletEntries,
    sessions,
    stamps,
    roomsHosted,
    liveRooms,
  ] = await Promise.all([
    socialStore.listPosts({ creatorId: uid, adult: true, status: 'all', page: 1, size: 50 }),
    mariaStore.query(
      `SELECT id, post_id, body, status, created_at
         FROM post_comments WHERE account_id = ? ORDER BY id DESC LIMIT 100`,
      [uid],
    ),
    mariaStore.query(
      `SELECT post_id, created_at FROM post_likes
        WHERE account_id = ? ORDER BY created_at DESC LIMIT 100`,
      [uid],
    ),
    mariaStore.query(
      `SELECT f.creator_id AS id, a.username, f.created_at
         FROM follows f JOIN accounts a ON a.id = f.creator_id
        WHERE f.follower_id = ? ORDER BY f.created_at DESC LIMIT 100`,
      [uid],
    ),
    mariaStore.query(
      `SELECT f.follower_id AS id, a.username, f.created_at
         FROM follows f JOIN accounts a ON a.id = f.follower_id
        WHERE f.creator_id = ? ORDER BY f.created_at DESC LIMIT 100`,
      [uid],
    ),
    mariaStore.query(
      `SELECT s.*, a.username AS other_username
         FROM subscriptions s JOIN accounts a ON a.id = s.creator_id
        WHERE s.subscriber_id = ? ORDER BY s.id DESC LIMIT 50`,
      [uid],
    ),
    mariaStore.query(
      `SELECT s.*, a.username AS other_username
         FROM subscriptions s JOIN accounts a ON a.id = s.subscriber_id
        WHERE s.creator_id = ? ORDER BY s.id DESC LIMIT 50`,
      [uid],
    ),
    socialStore.getCreatorSub(uid),
    mariaStore.query(
      'SELECT * FROM charges WHERE buyer_account_id = ? ORDER BY id DESC LIMIT 100',
      [uid],
    ),
    mariaStore.query(
      'SELECT * FROM charges WHERE payee_account_id = ? ORDER BY id DESC LIMIT 100',
      [uid],
    ),
    socialStore.getWallet(uid),
    socialStore.listWalletEntries({ accountId: uid, page: 1, size: 50 }),
    mariaStore.query(
      `SELECT COUNT(*) AS live, MAX(expires_at) AS latest, MIN(created_at) AS first
         FROM account_sessions WHERE account_id = ?`,
      [uid],
    ),
    mariaStore.query(
      `SELECT country, count, last_at FROM passport_stamps
        WHERE account_id = ? ORDER BY last_at DESC LIMIT 60`,
      [uid],
    ),
    mariaStore.query(
      `SELECT id, slug, title, kind, price, currency, is_adult, max_participants,
              status, created_at, ended_at
         FROM rooms WHERE host_account_id = ? ORDER BY id DESC LIMIT 50`,
      [uid],
    ),
    mariaStore.query(
      `SELECT slug, sid, country, at FROM rt_roomlive
        WHERE account_id = ? ORDER BY at DESC LIMIT 50`,
      [uid],
    ),
  ]);

  audit(admin, 'account.inspect', `#${uid} @${account.username}`);

  const photo = (kind) =>
    account[kind === 'banner' ? 'bannerKey' : 'avatarKey']
      ? `/api/profile/${encodeURIComponent(account.username)}/photo/${kind}`
      : null;

  return {
    account: {
      ...account,
      avatarUrl: photo('avatar'),
      bannerUrl: photo('banner'),
      // Counts the list screen never carries — the shape of "how much is
      // going on here" without opening five tabs.
      stats: {
        posts: posts.total || 0,
        comments: comments.length,
        likes: likes.length,
        following: following.length,
        followers: followers.length,
        subsBought: subsBought.length,
        subsSold: subsSold.length,
        chargesBought: chargesBought.length,
        chargesEarned: chargesEarned.length,
        sessions: Number(sessions[0]?.live) || 0,
        roomsHosted: roomsHosted.length,
      },
    },
    posts: posts.items,
    comments: comments.map((row) => ({
      id: Number(row.id),
      postId: Number(row.post_id),
      body: row.body,
      status: row.status,
      createdAt: row.created_at,
    })),
    likes: likes.map((row) => ({ postId: Number(row.post_id), createdAt: row.created_at })),
    following: following.map((row) => ({
      id: Number(row.id),
      username: row.username,
      createdAt: row.created_at,
    })),
    followers: followers.map((row) => ({
      id: Number(row.id),
      username: row.username,
      createdAt: row.created_at,
    })),
    subscriptions: {
      bought: subsBought.map(mapSubscription),
      sold: subsSold.map(mapSubscription),
      offer,
    },
    charges: {
      bought: chargesBought.map((row) => socialStore.mapCharge(row)),
      earned: chargesEarned.map((row) => socialStore.mapCharge(row)),
    },
    wallet,
    walletEntries: walletEntries.items,
    sessions: {
      live: Number(sessions[0]?.live) || 0,
      latest: sessions[0]?.latest || null,
      first: sessions[0]?.first || null,
    },
    stamps: stamps.map((row) => ({
      country: row.country,
      count: Number(row.count),
      lastAt: row.last_at,
    })),
    rooms: {
      hosted: roomsHosted.map((row) => ({
        id: Number(row.id),
        slug: row.slug,
        title: row.title,
        kind: row.kind,
        price: Number(row.price) || 0,
        currency: row.currency || 'KES',
        isAdult: Boolean(row.is_adult),
        maxParticipants: Number(row.max_participants) || 6,
        status: row.status,
        createdAt: row.created_at,
        endedAt: row.ended_at,
      })),
      live: liveRooms.map((row) => ({
        slug: row.slug,
        sid: row.sid,
        country: row.country,
        at: Number(row.at) || 0,
      })),
    },
  };
}

/**
 * One post in full: the row, every comment (including the removed ones —
 * moderation needs to see what was taken down and why), and who paid for it.
 * The media URL points at the admin-only stream, so a paid or 18+ post is
 * fully reviewable without buying it or passing the age gate.
 */
async function postDetail(admin, id) {
  requireDb();
  const post = await socialStore.getPost(Number(id), { withCountry: true });
  if (!post) throw new AuthError('not-found', 'That post no longer exists.', 404);

  const [comments, purchases] = await Promise.all([
    mariaStore.query(
      `SELECT id, post_id, account_id, username, body, status, created_at
         FROM post_comments WHERE post_id = ? ORDER BY id ASC LIMIT 200`,
      [Number(id)],
    ),
    mariaStore.query(
      `SELECT id, buyer_account_id, buyer_username, amount, status, paid_at, created_at
         FROM charges WHERE purpose = 'post' AND ref_id = ?
        ORDER BY id DESC LIMIT 100`,
      [Number(id)],
    ),
  ]);

  return {
    post: {
      ...post,
      mediaUrl: post.mediaKey ? `/api/admin/posts/${post.id}/media` : null,
    },
    comments: comments.map((row) => ({
      id: Number(row.id),
      postId: Number(row.post_id),
      accountId: Number(row.account_id),
      username: row.username,
      body: row.body,
      status: row.status,
      createdAt: row.created_at,
    })),
    purchases: purchases.map((row) => ({
      id: Number(row.id),
      buyerId: Number(row.buyer_account_id),
      buyer: row.buyer_username,
      amount: Number(row.amount),
      status: row.status,
      paidAt: row.paid_at,
      createdAt: row.created_at,
    })),
  };
}

/**
 * Stream a post's media straight to the dashboard, past the paywall and the
 * 18+ gate. This is the supervision exception: the owner is entitled to see
 * everything hosted on the platform, and the audit row records every paid or
 * adult file opened this way.
 */
async function readPostMedia(admin, id, res) {
  requireDb();
  const post = await socialStore.getPost(Number(id), { withCountry: false });
  if (!post || !post.mediaKey) throw new AuthError('not-found', 'That post has no media.', 404);
  const stored = await commerce.readMediaBytes(post.mediaKey);
  if (!stored) throw new AuthError('not-found', 'That file is missing.', 404);
  if (post.price > 0 || post.isAdult) {
    audit(admin, 'post.media.view', `#${post.id} @${post.creatorName}`, {
      price: post.price,
      isAdult: post.isAdult,
    });
  }
  return commerce.sendMedia(res, stored.data, stored.type, 'private, max-age=60');
}

/** One room in full: the row, who is inside right now, and who paid to get in. */
async function roomDetail(admin, id) {
  requireDb();
  const room = await socialStore.getRoomById(Number(id));
  if (!room) throw new AuthError('not-found', 'That room no longer exists.', 404);

  const [participants, purchases, roster] = await Promise.all([
    mariaStore.query(
      `SELECT sid, username, country, at FROM rt_roomlive
        WHERE slug = ? ORDER BY at DESC LIMIT 50`,
      [room.slug],
    ),
    mariaStore.query(
      `SELECT id, buyer_account_id, buyer_username, amount, status, paid_at, created_at
         FROM charges WHERE purpose = 'room' AND ref_id = ?
        ORDER BY id DESC LIMIT 100`,
      [Number(room.id)],
    ),
    mariaStore.query(
      `SELECT DISTINCT sid FROM rt_roomlive WHERE slug = ? LIMIT 100`,
      [room.slug],
    ),
  ]);

  return {
    room,
    participants: participants.map((row) => ({
      sid: row.sid,
      username: row.username,
      country: row.country,
      at: Number(row.at) || 0,
    })),
    headcount: roster.length,
    purchases: purchases.map((row) => ({
      id: Number(row.id),
      buyerId: Number(row.buyer_account_id),
      buyer: row.buyer_username,
      amount: Number(row.amount),
      status: row.status,
      paidAt: row.paid_at,
      createdAt: row.created_at,
    })),
  };
}

module.exports = {
  AuthError,
  init,
  bootstrap,
  resetFromEnv,
  login,
  authenticate,
  logout,
  audit,
  overview,
  databaseStats,
  pruneMedia,
  listUsers,
  updateUser,
  deleteUser,
  testMpesa,
  getSettings,
  saveSettings,
  listAudit,
  // Social platform
  listPosts,
  moderatePost,
  accountDetail,
  postDetail,
  readPostMedia,
  roomDetail,
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
