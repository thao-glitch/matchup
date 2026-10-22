/**
 * Social platform storage — posts, charges, wallets and rooms.
 *
 * The tables live in `mariaStore.js` (one schema, one boot pass) but the
 * queries live here so the money code stays in one readable file. Both share
 * the single connection pool through `mariaStore.query()`: this database runs
 * with `connectionLimit: 5`, and a second pool would only halve the headroom.
 *
 * Money rules enforced by this module, not by callers:
 *   • `balance` only ever moves with `UPDATE … SET balance = balance ± ?`,
 *     so two sales landing on the same wallet at the same instant cannot lose
 *     an update (read-modify-write would).
 *   • A charge flips `pending → paid` exactly once: the UPDATE carries
 *     `AND status = 'pending'`, and the winner (affectedRows === 1) is the
 *     only one credited. The M-PESA callback may be retried — that is safe.
 *   • A withdrawal reserves its amount (`balance >= ?` in the WHERE clause),
 *     so a balance can never go negative from a payout request.
 *
 * Everything is `async` and throws `err.code === 'DB_UNAVAILABLE'` with no
 * database configured — `commerce.js` turns that into the usual 503 envelope.
 */
const mariaStore = require('./mariaStore');
const crypto = require('crypto');
const mediaToken = require('./mediaToken');

const query = (...args) => mariaStore.query(...args);

// ── Mapping ──────────────────────────────────────────────────────────────────

/** DECIMAL columns come back as strings — every money value is normalized. */
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const iso = (value) => (value ? new Date(value).toISOString() : null);

function mapPost(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    creatorId: Number(row.account_id),
    creatorName: row.username,
    creatorCountry: row.country || '',
    type: row.type,
    caption: row.caption || '',
    mediaKey: row.media_key || null,
    linkUrl: row.link_url || null,
    price: num(row.price),
    currency: row.currency || 'KES',
    isAdult: Boolean(row.is_adult),
    status: row.status,
    views: Number(row.views) || 0,
    likes: Number(row.likes_n) || 0,
    comments: Number(row.comments_n) || 0,
    purchases: Number(row.purchases) || 0,
    createdAt: iso(row.created_at),
  };
}

function mapCharge(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    purpose: row.purpose,
    refId: Number(row.ref_id),
    buyerId: Number(row.buyer_account_id),
    buyerUsername: row.buyer_username,
    payeeId: Number(row.payee_account_id),
    payeeUsername: row.payee_username,
    phone: row.phone,
    amount: num(row.amount),
    currency: row.currency || 'KES',
    commission: num(row.commission),
    net: num(row.net),
    status: row.status,
    checkoutRequestId: row.checkout_request_id || null,
    mpesaRef: row.mpesa_receipt || null,
    error: row.result_desc || null,
    note: row.note || null,
    createdAt: iso(row.created_at),
    paidAt: iso(row.paid_at),
  };
}

function mapWallet(row) {
  if (!row) return null;
  return {
    accountId: Number(row.account_id),
    username: row.username || '',
    balance: num(row.balance),
    lifetimeIn: num(row.lifetime_in),
    lifetimeOut: num(row.lifetime_out),
    updatedAt: iso(row.updated_at),
  };
}

function mapEntry(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    accountId: Number(row.account_id),
    amount: num(row.amount),
    kind: row.kind,
    status: row.status,
    chargeId: row.charge_id == null ? null : Number(row.charge_id),
    memo: row.note || row.memo || null,
    createdAt: iso(row.created_at),
  };
}

function mapRoom(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    hostId: Number(row.host_account_id),
    hostName: row.host_username,
    price: num(row.price),
    currency: row.currency || 'KES',
    isAdult: Boolean(row.is_adult),
    maxParticipants: Number(row.max_participants) || 6,
    status: row.status,
    createdAt: iso(row.created_at),
    endedAt: iso(row.ended_at),
  };
}

function mapComment(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    postId: Number(row.post_id),
    username: row.username,
    body: row.body,
    status: row.status,
    createdAt: iso(row.created_at),
  };
}

// ── Pagination helpers ───────────────────────────────────────────────────────

const pageSize = (size, fallback = 20) =>
  Math.min(50, Math.max(1, Number(size) || fallback));
const pageNumber = (page) => Math.max(1, Number(page) || 1);

// ── Posts ────────────────────────────────────────────────────────────────────

async function insertPost({
  accountId,
  username,
  type = 'text',
  caption = '',
  mediaKey = null,
  linkUrl = null,
  price = 0,
  currency = 'KES',
  isAdult = false,
}) {
  const res = await query(
    `INSERT INTO posts
       (account_id, username, type, caption, media_key, link_url, price, currency, is_adult)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      accountId,
      username,
      type,
      String(caption).slice(0, 2000),
      mediaKey,
      linkUrl,
      Math.max(0, num(price)),
      currency,
      isAdult ? 1 : 0,
    ],
  );
  return getPost(res.insertId);
}

async function getPost(id, { withCountry = true } = {}) {
  const rows = await query(
    `SELECT p.*, ${withCountry ? 'a.country AS country,' : ''}
            (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS like_count,
            (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id AND c.status = 'active') AS comment_count
       FROM posts p
       ${withCountry ? 'LEFT JOIN accounts a ON a.id = p.account_id' : ''}
      WHERE p.id = ?
      LIMIT 1`,
    [Number(id)],
  );
  const row = rows[0];
  if (!row) return null;
  const mapped = mapPost(row);
  mapped.likes = Number(row.like_count) || mapped.likes;
  mapped.comments = Number(row.comment_count) || mapped.comments;
  return mapped;
}

/**
 * One page of the feed.
 *
 * Default (no flags) is the public feed: `active` posts, adult hidden.
 * `creatorId + all` is "my posts" (the creator sees their own hidden rows);
 * `status` is the dashboard's lens — `'all'` means no filter at all.
 * Adult posts are excluded unless `adult` is requested, so the viewer's
 * switch decides and the server never hands them to a feed that did not ask.
 */
async function listPosts({
  page = 1,
  size = 20,
  q = '',
  adult = false,
  creatorId = null,
  all = false,
  status = '',
} = {}) {
  const limit = pageSize(size);
  const offset = (pageNumber(page) - 1) * limit;

  const where = [];
  const params = [];

  if (creatorId) {
    where.push('p.account_id = ?');
    params.push(Number(creatorId));
  }
  if (status && status !== 'all') {
    where.push('p.status = ?');
    params.push(status);
  } else if (status !== 'all') {
    if (creatorId && all) where.push("p.status <> 'removed'");
    else where.push("p.status = 'active'");
  }
  if (!adult) where.push('p.is_adult = 0');
  if (q) {
    where.push('(p.caption LIKE ? OR p.username LIKE ?)');
    const like = `%${String(q).replace(/[%_]/g, (m) => `\\${m}`)}%`;
    params.push(like, like);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const [countRows] = await query(
    `SELECT COUNT(*) AS total FROM posts p ${whereSql}`,
    params,
  );
  const rows = await query(
    `SELECT p.*, a.country AS country,
            (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id) AS like_count,
            (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id AND c.status = 'active') AS comment_count
       FROM posts p
       LEFT JOIN accounts a ON a.id = p.account_id
       ${whereSql}
      ORDER BY p.id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  const items = rows.map((row) => {
    const mapped = mapPost(row);
    mapped.likes = Number(row.like_count) || mapped.likes;
    mapped.comments = Number(row.comment_count) || mapped.comments;
    return mapped;
  });
  return { items, total: Number(countRows?.total) || 0, page: pageNumber(page), size: limit };
}

/** Feed items → viewer-specific flags in two batched queries, not 2×N. */
async function decorateForViewer(posts, accountId, adultOk = false) {
  if (!posts.length) return posts;
  // `mediaUrl` follows the same rule as the detail route: a viewer who may
  // see the media (free, or paid for) gets the gated URL; everyone else gets
  // null. Without this the feed/explore lists never carry a URL at all and
  // every image post would render its "Media unavailable" fallback.
  // A *paid* URL additionally carries `?t=` — an <img> tag cannot send a
  // Bearer header, so the claim is the only proof the media route will see.
  const urlFor = (p, owned) => {
    if (!owned || !p.mediaKey) return null;
    const claim = p.price > 0 && accountId ? `?t=${mediaToken.mint(p.id, accountId, adultOk)}` : '';
    return `/api/posts/${p.id}/media${claim}`;
  };
  if (!accountId) {
    return posts.map((p) => ({
      ...p,
      liked: false,
      owned: p.price <= 0,
      mediaUrl: urlFor(p, p.price <= 0),
    }));
  }
  const ids = posts.map((p) => p.id);
  const placeholders = ids.map(() => '?').join(',');
  const [likes, owned] = await Promise.all([
    query(
      `SELECT post_id FROM post_likes WHERE account_id = ? AND post_id IN (${placeholders})`,
      [accountId, ...ids],
    ),
    query(
      `SELECT ref_id FROM charges
        WHERE buyer_account_id = ? AND purpose = 'post' AND status = 'paid'
          AND ref_id IN (${placeholders})`,
      [accountId, ...ids],
    ),
  ]);
  const likedSet = new Set(likes.map((r) => Number(r.post_id)));
  const ownedSet = new Set(owned.map((r) => Number(r.ref_id)));
  return posts.map((p) => {
    // The creator owns their work by definition — the detail route has always
    // said so; without it here a creator's own priced post renders locked on
    // their own profile (and withholds its thumbnail).
    const owned =
      p.price <= 0 || Number(p.creatorId) === Number(accountId) || ownedSet.has(p.id);
    return {
      ...p,
      liked: likedSet.has(p.id),
      owned,
      mediaUrl: urlFor(p, owned),
    };
  });
}

async function updatePostStatus(id, status) {
  await query('UPDATE posts SET status = ? WHERE id = ?', [status, Number(id)]);
  return getPost(id);
}

async function deletePost(id) {
  const res = await query('DELETE FROM posts WHERE id = ?', [Number(id)]);
  return Number(res.affectedRows) > 0;
}

/** Fire-and-forget: a slow counter must never slow the detail response. */
function countView(id) {
  query('UPDATE posts SET views = views + 1 WHERE id = ?', [Number(id)]).catch(() => undefined);
}

async function likePost(postId, accountId, liked) {
  if (liked) {
    await query(
      'INSERT IGNORE INTO post_likes (post_id, account_id) VALUES (?, ?)',
      [Number(postId), Number(accountId)],
    );
  } else {
    await query('DELETE FROM post_likes WHERE post_id = ? AND account_id = ?', [
      Number(postId),
      Number(accountId),
    ]);
  }
  // Re-count instead of ±1: an INSERT IGNORE miss would drift the counter.
  await query('UPDATE posts SET likes_n = (SELECT COUNT(*) FROM post_likes WHERE post_id = ?) WHERE id = ?', [
    Number(postId),
    Number(postId),
  ]);
  const rows = await query('SELECT likes_n FROM posts WHERE id = ?', [Number(postId)]);
  return { liked, likes: Number(rows[0]?.likes_n) || 0 };
}

async function listComments(postId, limit = 100) {
  const rows = await query(
    `SELECT * FROM post_comments WHERE post_id = ? AND status = 'active' ORDER BY id ASC LIMIT ${Math.min(500, Math.max(1, Number(limit) || 100))}`,
    [Number(postId)],
  );
  return rows.map(mapComment);
}

async function insertComment({ postId, accountId, username, body }) {
  const res = await query(
    'INSERT INTO post_comments (post_id, account_id, username, body) VALUES (?, ?, ?, ?)',
    [Number(postId), Number(accountId), username, String(body).slice(0, 500)],
  );
  await query('UPDATE posts SET comments_n = comments_n + 1 WHERE id = ?', [Number(postId)]);
  const rows = await query('SELECT * FROM post_comments WHERE id = ?', [res.insertId]);
  return mapComment(rows[0]);
}

async function setCommentStatus(id, status) {
  await query('UPDATE post_comments SET status = ? WHERE id = ?', [status, Number(id)]);
  const rows = await query('SELECT * FROM post_comments WHERE id = ?', [Number(id)]);
  return mapComment(rows[0]);
}

// ── Charges ──────────────────────────────────────────────────────────────────

async function insertCharge({
  purpose,
  refId,
  buyerId,
  buyerUsername,
  payeeId,
  payeeUsername,
  phone,
  amount,
  currency,
  commission,
  net,
}) {
  const res = await query(
    `INSERT INTO charges
       (purpose, ref_id, buyer_account_id, buyer_username, payee_account_id,
        payee_username, phone, amount, currency, commission, net)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      purpose,
      Number(refId),
      Number(buyerId),
      buyerUsername,
      Number(payeeId),
      payeeUsername,
      phone,
      num(amount),
      currency,
      num(commission),
      num(net),
    ],
  );
  return getCharge(res.insertId);
}

async function getCharge(id) {
  const rows = await query('SELECT * FROM charges WHERE id = ?', [Number(id)]);
  return mapCharge(rows[0]);
}

async function getChargeByCheckout(checkoutRequestId) {
  if (!checkoutRequestId) return null;
  const rows = await query('SELECT * FROM charges WHERE checkout_request_id = ?', [
    String(checkoutRequestId),
  ]);
  return mapCharge(rows[0]);
}

/** The still-open charge for one buyer + one thing (idempotent creation). */
async function findOpenCharge({ purpose, refId, buyerId }) {
  const rows = await query(
    `SELECT * FROM charges
      WHERE purpose = ? AND ref_id = ? AND buyer_account_id = ? AND status = 'pending'
        AND created_at > NOW() - INTERVAL 5 MINUTE
      ORDER BY id DESC LIMIT 1`,
    [purpose, Number(refId), Number(buyerId)],
  );
  return mapCharge(rows[0]);
}

/** Has this buyer already paid for this thing? The entitlement check. */
async function isEntitled({ purpose, refId, accountId }) {
  const rows = await query(
    `SELECT 1 FROM charges
      WHERE purpose = ? AND ref_id = ? AND buyer_account_id = ? AND status = 'paid'
      LIMIT 1`,
    [purpose, Number(refId), Number(accountId)],
  );
  return rows.length > 0;
}

/** Many refs at once — powers the feed's `owned` flag without N queries. */
async function entitledRefIds({ purpose, accountId, refIds }) {
  if (!refIds.length) return new Set();
  const placeholders = refIds.map(() => '?').join(',');
  const rows = await query(
    `SELECT ref_id FROM charges
      WHERE purpose = ? AND buyer_account_id = ? AND status = 'paid' AND ref_id IN (${placeholders})`,
    [purpose, Number(accountId), ...refIds],
  );
  return new Set(rows.map((r) => Number(r.ref_id)));
}

/**
 * Flip a charge to `paid` — exactly once.
 *
 * The WHERE clause on `status = 'pending'` is the whole point: a retried
 * M-PESA callback, a manual admin approval racing it, or a status poll all
 * collapse into "the first one wins, everyone else sees affectedRows 0".
 *
 * @returns {Promise<boolean>} true when THIS call performed the settlement
 */
async function markChargePaid(id, { receipt = null, resultCode = 0, resultDesc = null } = {}) {
  const res = await query(
    `UPDATE charges
        SET status = 'paid', mpesa_receipt = COALESCE(?, mpesa_receipt),
            result_code = ?, result_desc = COALESCE(?, result_desc),
            paid_at = NOW()
      WHERE id = ? AND status = 'pending'`,
    [receipt, Number(resultCode) || 0, resultDesc, Number(id)],
  );
  return Number(res.affectedRows) > 0;
}

async function markChargeFailed(id, { resultCode = null, resultDesc = null, note = null } = {}) {
  const res = await query(
    `UPDATE charges
        SET status = 'failed', result_code = ?, result_desc = COALESCE(?, result_desc),
            note = COALESCE(?, note)
      WHERE id = ? AND status = 'pending'`,
    [resultCode == null ? null : Number(resultCode), resultDesc, note, Number(id)],
  );
  return Number(res.affectedRows) > 0;
}

/** Pending charges older than the STK lifetime are dead — swept lazily. */
async function expireStaleCharges() {
  const res = await query(
    `UPDATE charges SET status = 'expired', result_desc = 'Request timed out'
      WHERE status = 'pending' AND checkout_request_id IS NOT NULL
        AND created_at < NOW() - INTERVAL 5 MINUTE`,
  );
  return Number(res.affectedRows) || 0;
}

async function listCharges({ status = '', purpose = '', page = 1, size = 25, q = '' } = {}) {
  const limit = pageSize(size, 25);
  const offset = (pageNumber(page) - 1) * limit;
  const where = [];
  const params = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (purpose) {
    where.push('purpose = ?');
    params.push(purpose);
  }
  if (q) {
    where.push('(buyer_username LIKE ? OR payee_username LIKE ? OR phone LIKE ?)');
    const like = `%${String(q).replace(/[%_]/g, (m) => `\\${m}`)}%`;
    params.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [countRows] = await query(`SELECT COUNT(*) AS total FROM charges ${whereSql}`, params);
  const rows = await query(
    `SELECT * FROM charges ${whereSql} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return {
    items: rows.map(mapCharge),
    total: Number(countRows?.total) || 0,
    page: pageNumber(page),
    size: limit,
  };
}

async function chargeSummary({ days = 30 } = {}) {
  const [totals] = await query(
    `SELECT
        COUNT(*) AS count,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN amount END), 0) AS paid_gross,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN commission END), 0) AS paid_commission,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN net END), 0) AS paid_net,
        SUM(status = 'pending') AS pending,
        SUM(status = 'paid') AS paid,
        SUM(status = 'failed') AS failed,
        SUM(status = 'expired') AS expired
      FROM charges`,
  );
  const byDay = await query(
    `SELECT DATE(paid_at) AS day, COUNT(*) AS count,
            COALESCE(SUM(amount), 0) AS gross,
            COALESCE(SUM(commission), 0) AS commission
       FROM charges
      WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL ${Math.max(1, Number(days) || 30)} DAY
      GROUP BY DATE(paid_at)
      ORDER BY day ASC`,
  );
  return {
    count: Number(totals?.count) || 0,
    gross: num(totals?.paid_gross),
    commission: num(totals?.paid_commission),
    net: num(totals?.paid_net),
    pending: Number(totals?.pending) || 0,
    paid: Number(totals?.paid) || 0,
    failed: Number(totals?.failed) || 0,
    expired: Number(totals?.expired) || 0,
    byDay: byDay.map((r) => ({
      day: typeof r.day === 'string' ? r.day.slice(0, 10) : iso(r.day)?.slice(0, 10),
      count: Number(r.count) || 0,
      gross: num(r.gross),
      commission: num(r.commission),
    })),
  };
}

// ── Wallets ──────────────────────────────────────────────────────────────────

/** Create-on-read: every account gets a wallet the first time anyone asks. */
async function getWallet(accountId) {
  const id = Number(accountId);
  if (!id) return null;
  await query('INSERT IGNORE INTO wallets (account_id) VALUES (?)', [id]);
  const rows = await query(
    `SELECT w.*, a.username AS username
       FROM wallets w LEFT JOIN accounts a ON a.id = w.account_id
      WHERE w.account_id = ?`,
    [id],
  );
  return mapWallet(rows[0]);
}

async function listWallets({ page = 1, size = 25, q = '' } = {}) {
  const limit = pageSize(size, 25);
  const offset = (pageNumber(page) - 1) * limit;
  const where = q ? 'WHERE a.username LIKE ?' : '';
  const params = q ? [`%${String(q).replace(/[%_]/g, (m) => `\\${m}`)}%`] : [];
  const [countRows] = await query(
    `SELECT COUNT(*) AS total FROM wallets w LEFT JOIN accounts a ON a.id = w.account_id ${where}`,
    params,
  );
  const rows = await query(
    `SELECT w.*, a.username AS username
       FROM wallets w LEFT JOIN accounts a ON a.id = w.account_id
       ${where}
      ORDER BY w.balance DESC, w.account_id ASC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return {
    items: rows.map(mapWallet),
    total: Number(countRows?.total) || 0,
    page: pageNumber(page),
    size: limit,
  };
}

/**
 * Credit a wallet and append the ledger row in one round-trip-safe sequence.
 * The INSERT IGNORE on `wallets` makes "first sale of the account" and
 * "n-th sale" take the same path.
 */
async function creditWallet(accountId, amount, { kind = 'sale', chargeId = null, memo = null } = {}) {
  const id = Number(accountId);
  const value = num(amount);
  if (!id || value <= 0) return null;
  await query('INSERT IGNORE INTO wallets (account_id) VALUES (?)', [id]);
  await query('UPDATE wallets SET balance = balance + ?, lifetime_in = lifetime_in + ? WHERE account_id = ?', [
    value,
    value,
    id,
  ]);
  const res = await query(
    'INSERT INTO wallet_entries (account_id, amount, kind, status, charge_id, memo) VALUES (?, ?, ?, ?, ?, ?)',
    [id, value, kind, 'posted', chargeId ? Number(chargeId) : null, memo ? String(memo).slice(0, 160) : null],
  );
  const entryRows = await query('SELECT * FROM wallet_entries WHERE id = ?', [res.insertId]);
  return { wallet: await getWallet(id), entry: mapEntry(entryRows[0]) };
}

/**
 * Reserve a payout: `balance >= amount` is part of the UPDATE's WHERE, so two
 * simultaneous withdrawal requests cannot both succeed against one balance.
 *
 * @returns {Promise<object|null>} the ledger row, or null when short of funds
 */
async function reserveWithdrawal(accountId, amount, { phone = '', memo = null } = {}) {
  const id = Number(accountId);
  const value = num(amount);
  if (!id || value <= 0) return null;
  await query('INSERT IGNORE INTO wallets (account_id) VALUES (?)', [id]);
  const res = await query(
    `UPDATE wallets SET balance = balance - ?, lifetime_out = lifetime_out + ?
      WHERE account_id = ? AND balance >= ?`,
    [value, value, id, value],
  );
  if (Number(res.affectedRows) === 0) return null;
  const entry = await query(
    `INSERT INTO wallet_entries (account_id, amount, kind, status, memo)
     VALUES (?, ?, 'withdrawal', 'pending', ?)`,
    [id, -value, (memo || `Payout to ${phone}`).slice(0, 160)],
  );
  const rows = await query('SELECT * FROM wallet_entries WHERE id = ?', [entry.insertId]);
  return mapEntry(rows[0]);
}

async function getWalletEntry(id) {
  const rows = await query('SELECT * FROM wallet_entries WHERE id = ?', [Number(id)]);
  return mapEntry(rows[0]);
}

async function listWalletEntries({ accountId = null, status = '', page = 1, size = 25 } = {}) {
  const limit = pageSize(size, 25);
  const offset = (pageNumber(page) - 1) * limit;
  const where = [];
  const params = [];
  if (accountId) {
    where.push('e.account_id = ?');
    params.push(Number(accountId));
  }
  if (status) {
    where.push('e.status = ?');
    params.push(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [countRows] = await query(
    `SELECT COUNT(*) AS total FROM wallet_entries e ${whereSql}`,
    params,
  );
  const rows = await query(
    `SELECT e.*, a.username AS username
       FROM wallet_entries e LEFT JOIN accounts a ON a.id = e.account_id
       ${whereSql}
      ORDER BY e.id DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return {
    items: rows.map((row) => ({ ...mapEntry(row), username: row.username || '' })),
    total: Number(countRows?.total) || 0,
    page: pageNumber(page),
    size: limit,
  };
}

/**
 * Resolve a pending withdrawal: `approved` keeps the reservation (money left),
 * `rejected` hands it back to the balance.
 *
 * @returns {Promise<object|null>} the updated row, or null when it was not
 *          pending (double-click safe)
 */
async function settleWithdrawal(id, status) {
  const rows = await query(`SELECT * FROM wallet_entries WHERE id = ? AND status = 'pending'`, [
    Number(id),
  ]);
  const entry = rows[0];
  if (!entry) return null;
  if (status === 'rejected') {
    await query('UPDATE wallets SET balance = balance + ?, lifetime_out = lifetime_out - ? WHERE account_id = ?', [
      Math.abs(num(entry.amount)),
      Math.abs(num(entry.amount)),
      Number(entry.account_id),
    ]);
  }
  await query('UPDATE wallet_entries SET status = ? WHERE id = ?', [status, Number(id)]);
  return getWalletEntry(id);
}

/** Signed adjustment from the dashboard (positive = credit, negative = debit). */
async function adjustWallet(accountId, amount, memo) {
  const id = Number(accountId);
  const value = num(amount);
  if (!id || !value) throw Object.assign(new Error('amount required'), { code: 'VALIDATION' });
  await query('INSERT IGNORE INTO wallets (account_id) VALUES (?)', [id]);
  if (value < 0) {
    const res = await query(
      'UPDATE wallets SET balance = balance + ? WHERE account_id = ? AND balance >= ?',
      [value, id, -value],
    );
    if (Number(res.affectedRows) === 0) {
      throw Object.assign(new Error('Adjustment exceeds the wallet balance.'), {
        code: 'INSUFFICIENT',
      });
    }
  } else {
    await query('UPDATE wallets SET balance = balance + ?, lifetime_in = lifetime_in + ? WHERE account_id = ?', [
      value,
      value,
      id,
    ]);
  }
  await query(
    'INSERT INTO wallet_entries (account_id, amount, kind, status, memo) VALUES (?, ?, ?, ?, ?)',
    [id, value, 'adjustment', 'posted', String(memo || 'Admin adjustment').slice(0, 160)],
  );
  return getWallet(id);
}

async function walletStats() {
  const [row] = await query(
    `SELECT COALESCE(SUM(balance), 0) AS held,
            COALESCE(SUM(lifetime_in), 0) AS earned,
            COALESCE(SUM(lifetime_out), 0) AS paid_out,
            COUNT(*) AS wallets
       FROM wallets`,
  );
  const [pending] = await query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(-amount), 0) AS amount
       FROM wallet_entries WHERE kind = 'withdrawal' AND status = 'pending'`,
  );
  return {
    held: num(row?.held),
    earned: num(row?.earned),
    paidOut: num(row?.paid_out),
    wallets: Number(row?.wallets) || 0,
    pendingPayouts: Number(pending?.count) || 0,
    pendingAmount: num(pending?.amount),
  };
}

// ── Rooms ────────────────────────────────────────────────────────────────────

const randomSlug = () => `r${crypto.randomBytes(4).toString('hex')}`;

async function insertRoom({
  title,
  kind = 'group',
  hostId,
  hostUsername,
  price = 0,
  currency = 'KES',
  isAdult = false,
  maxParticipants = 6,
}) {
  // A short unique slug keeps join URLs copyable; retry on the (rare) collision.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const slug = randomSlug();
    try {
      const res = await query(
        `INSERT INTO rooms
           (slug, title, kind, host_account_id, host_username, price, currency, is_adult, max_participants)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          slug,
          String(title).slice(0, 80),
          kind === 'conference' ? 'conference' : 'group',
          Number(hostId),
          hostUsername,
          Math.max(0, num(price)),
          currency,
          isAdult ? 1 : 0,
          Math.min(12, Math.max(2, Number(maxParticipants) || 6)),
        ],
      );
      return getRoomById(res.insertId);
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
    }
  }
  throw new Error('could not allocate a room link');
}

async function getRoomById(id) {
  const rows = await query('SELECT * FROM rooms WHERE id = ?', [Number(id)]);
  return mapRoom(rows[0]);
}

async function getRoomBySlug(slug) {
  const rows = await query('SELECT * FROM rooms WHERE slug = ?', [String(slug)]);
  return mapRoom(rows[0]);
}

async function listRooms({ kind = '', status = 'live', adult = null, page = 1, size = 50 } = {}) {
  const limit = pageSize(size, 50);
  const offset = (pageNumber(page) - 1) * limit;
  const where = [];
  const params = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (kind) {
    where.push('kind = ?');
    params.push(kind);
  }
  if (adult === false) where.push('is_adult = 0');
  if (adult === true) where.push('is_adult = 1');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [countRows] = await query(`SELECT COUNT(*) AS total FROM rooms ${whereSql}`, params);
  const rows = await query(
    `SELECT * FROM rooms ${whereSql} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return {
    items: rows.map(mapRoom),
    total: Number(countRows?.total) || 0,
    page: pageNumber(page),
    size: limit,
  };
}

async function setRoomStatus(id, status) {
  await query('UPDATE rooms SET status = ?, ended_at = IF(? = \'ended\', NOW(), ended_at) WHERE id = ?', [
    status,
    status,
    Number(id),
  ]);
  return getRoomById(id);
}

async function roomStats() {
  const [row] = await query(
    `SELECT SUM(status = 'live') AS live, COUNT(*) AS total FROM rooms`,
  );
  return { live: Number(row?.live) || 0, total: Number(row?.total) || 0 };
}

module.exports = {
  // posts
  insertPost,
  getPost,
  listPosts,
  decorateForViewer,
  updatePostStatus,
  deletePost,
  countView,
  likePost,
  listComments,
  insertComment,
  setCommentStatus,
  // charges
  insertCharge,
  getCharge,
  getChargeByCheckout,
  findOpenCharge,
  isEntitled,
  entitledRefIds,
  markChargePaid,
  markChargeFailed,
  expireStaleCharges,
  listCharges,
  chargeSummary,
  // wallets
  getWallet,
  listWallets,
  creditWallet,
  reserveWithdrawal,
  getWalletEntry,
  listWalletEntries,
  settleWithdrawal,
  adjustWallet,
  walletStats,
  // rooms
  insertRoom,
  getRoomById,
  getRoomBySlug,
  listRooms,
  setRoomStatus,
  roomStats,
  // mapping (shared with the admin layer)
  mapPost,
  mapCharge,
  mapWallet,
  mapEntry,
  mapRoom,
  mapComment,
};
