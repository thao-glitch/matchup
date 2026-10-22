/**
 * Commerce — the business rules behind paid content.
 *
 * One module owns every decision about money so the HTTP routes stay thin:
 *
 *   • a creator sets a price → the split (house commission vs. creator net)
 *     is computed in exactly one place, `split()`;
 *   • a viewer pays → `createCharge()` opens a row, fires the STK push, and
 *     `settle()` credits the creator's wallet exactly once, whoever asks
 *     first (callback, status poll, or the owner approving manually);
 *   • entitlement is never stored on the post — it is derived from a `paid`
 *     charge, so refunds/adjustments can never strand a viewer.
 *
 * The18+ rule is enforced here, server-side: an adult post or room needs
 * `commerce.adult` on AND a signed-in account whose profile age is ≥ 18. The
 * client's "I am 18 or over" switch is a UX gate, never the security gate.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mariaStore = require('./mariaStore');
const socialStore = require('./socialStore');
const settings = require('./settings');
const accounts = require('./accounts');
const mpesa = require('./mpesa');

const { AuthError } = accounts;

/** `maria` = the platform works, `memory` = social features are off. */
let backend = 'memory';

function init(storeMode) {
  backend = storeMode === 'maria' ? 'maria' : 'memory';
}

function requireDb() {
  if (backend !== 'maria') {
    throw new AuthError(
      'storage',
      'The social platform needs the database — MARIADB_* is not configured on this server.',
      503,
    );
  }
}

const cfg = () => settings.get().commerce;

/** The house cut: `gross → { commission, net }`, rounded to whole cents. */
function split(amount) {
  const gross = Math.max(0, Math.round(Number(amount) || 0));
  const rate = cfg().commissionRate;
  const commission = Math.round((gross * rate) / 100);
  return { gross, commission, net: gross - commission };
}

function requireUser(user) {
  if (!user || typeof user.id !== 'number') {
    throw new AuthError('unauthorized', 'Please sign in to continue.', 401);
  }
  return user;
}

/** Age gate for18+ content — the server's own check, not the client's. */
function isAdultAllowed(user) {
  if (!cfg().adult) return false;
  return Boolean(user && Number(user.profile?.age) >= 18);
}

function requireEnabled(flag, message) {
  const c = cfg();
  if (!c.enabled || !c[flag]) {
    throw new AuthError(flag === 'social' ? 'social-disabled' : 'groups-disabled', message, 409);
  }
}

// ── Media uploads ────────────────────────────────────────────────────────────

/** Where paid media lives: NOT statically served — only via the gated route. */
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

const MEDIA_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

/**
 * Store one raw upload. The bytes come from `express.raw()` in `server.js`;
 * this validates the type and drops the file on disk under a random key.
 *
 * @returns {Promise<string>} the key to hand to `POST /api/posts`
 */
async function saveUpload({ buffer, contentType }) {
  requireDb();
  const ext = MEDIA_TYPES[String(contentType || '').split(';')[0].trim().toLowerCase()];
  if (!ext) {
    throw new AuthError('media-type', 'Upload an image (JPEG, PNG, WebP, GIF) or a video (MP4, WebM).', 415);
  }
  if (!buffer || !buffer.length) {
    throw new AuthError('media-empty', 'That file is empty — choose another one.', 400);
  }
  const key = `${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}${ext}`;
  await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(UPLOAD_DIR, key), buffer);
  return key;
}

const safeKey = (key) => /^[A-Za-z0-9._-]{4,80}$/.test(String(key || ''));

// ── Posts ────────────────────────────────────────────────────────────────────

/**
 * Publish a post. The price is clamped to the configured band and forced to
 * whole shillings (Daraja only moves integers, so a `KES 7.50` price would
 * only ever settle as 8 and make the split look broken).
 */
async function createPost(user, input = {}) {
  requireDb();
  requireUser(user);
  requireEnabled('social', 'Posts are switched off right now — check back soon.');

  const c = cfg();
  const type = ['image', 'video', 'link', 'text'].includes(input.type) ? input.type : 'text';
  const caption = String(input.caption ?? '').trim().slice(0, 2000);
  const mediaKey = input.mediaKey ? String(input.mediaKey) : null;
  const linkUrl = input.linkUrl ? String(input.linkUrl).trim().slice(0, 500) : null;

  if (!caption && type === 'text') {
    throw new AuthError('caption', 'Write something first.', 400);
  }
  if (type === 'image' || type === 'video') {
    if (!mediaKey || !safeKey(mediaKey)) {
      throw new AuthError('media', 'Upload a file first — or pick a link post.', 400);
    }
    if (!fs.existsSync(path.join(UPLOAD_DIR, mediaKey))) {
      throw new AuthError('media', 'That upload did not land — try again.', 400);
    }
  }
  if (type === 'link') {
    if (!linkUrl || !/^https?:\/\//i.test(linkUrl)) {
      throw new AuthError('link', 'Link posts need a full https:// address.', 400);
    }
  }

  const isAdult = Boolean(input.isAdult);
  if (isAdult) {
    if (!c.adult) {
      throw new AuthError('adult-disabled', '18+ content is switched off on this platform.', 409);
    }
    if (!isAdultAllowed(user)) {
      throw new AuthError('adult-only', '18+ posts are for accounts aged 18 and over.', 403);
    }
  }

  // Free (0) is allowed; anything else is clamped into the configured band.
  let price = Math.round(Number(input.price) || 0);
  if (price > 0) {
    price = Math.min(c.maxPrice, Math.max(c.minPrice, price));
  }

  return socialStore.insertPost({
    accountId: user.id,
    username: user.username,
    type,
    caption,
    mediaKey: type === 'image' || type === 'video' ? mediaKey : null,
    linkUrl: type === 'link' ? linkUrl : null,
    price,
    currency: c.currency,
    isAdult,
  });
}

/** One page of the feed, decorated with the viewer's own liked/owned flags. */
async function feed(user, { page, size, q, adult } = {}) {
  requireDb();
  const wantsAdult = adult === true || adult === '1' || adult === 1;
  // The adult shelf only exists for signed-in adults — regardless of the switch.
  const showAdult = wantsAdult && isAdultAllowed(user);
  const result = await socialStore.listPosts({ page, size, q, adult: showAdult });
  const items = await socialStore.decorateForViewer(result.items, user?.id ?? null);
  return { ...result, items };
}

/** The creator's own page: hidden rows included, someone else's never. */
async function mine(user, { page, size } = {}) {
  requireDb();
  requireUser(user);
  const result = await socialStore.listPosts({
    page,
    size,
    creatorId: user.id,
    all: true,
    adult: true,
  });
  const items = await socialStore.decorateForViewer(result.items, user.id);
  return { ...result, items };
}

/**
 * A single post as the viewer may see it — counts a view, and never leaks
 * `mediaKey` for content they have not paid for.
 */
async function postDetail(user, id) {
  requireDb();
  const post = await socialStore.getPost(id);
  if (!post || post.status === 'removed') {
    throw new AuthError('not-found', 'That post is no longer here.', 404);
  }
  if (post.isAdult && !isAdultAllowed(user)) {
    throw new AuthError('adult-only', 'This post is for accounts aged 18 and over.', 403);
  }

  const owned =
    post.price <= 0 ||
    post.creatorId === user?.id ||
    (await socialStore.isEntitled({
      purpose: 'post',
      refId: post.id,
      accountId: user?.id ?? -1,
    }));
  const liked = user
    ? (await socialStore.decorateForViewer([{ ...post, owned }], user.id))[0].liked
    : false;

  // The owner always sees their own numbers go up; a viewer's hit is cheap
  // enough to count too (it is one fire-and-forget UPDATE).
  socialStore.countView(post.id);

  const { mediaKey, ...safe } = post;
  return {
    post: {
      ...safe,
      liked,
      owned,
      mediaUrl: owned && post.mediaKey ? `/api/posts/${post.id}/media` : null,
    },
  };
}

/**
 * Stream the media file behind a post — the paywall's enforcement point.
 * Files are never exposed statically, so this is the only way in.
 */
async function readPostMedia(user, id, res) {
  requireDb();
  const post = await socialStore.getPost(id, { withCountry: false });
  if (!post || post.status === 'removed' || !post.mediaKey) {
    throw new AuthError('not-found', 'No media on that post.', 404);
  }
  if (post.isAdult && !isAdultAllowed(user)) {
    throw new AuthError('adult-only', 'This post is for accounts aged 18 and over.', 403);
  }
  const owned =
    post.price <= 0 ||
    post.creatorId === user?.id ||
    (await socialStore.isEntitled({ purpose: 'post', refId: post.id, accountId: user?.id ?? -1 }));
  if (!owned) {
    throw new AuthError('payment-required', 'Pay to unlock this post.', 402);
  }

  const file = path.join(UPLOAD_DIR, path.basename(post.mediaKey));
  if (!safeKey(path.basename(post.mediaKey)) || !fs.existsSync(file)) {
    throw new AuthError('not-found', 'That file is missing — the creator can re-upload it.', 404);
  }
  const stat = await fs.promises.stat(file);
  const type =
    Object.entries(MEDIA_TYPES).find(([, ext]) => file.endsWith(ext))?.[0] || 'application/octet-stream';

  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Cache-Control', 'private, max-age=60');
  // Range support keeps <video> seeking usable without a second copy.
  const range = res.req.headers.range;
  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      if (start < stat.size) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
        res.setHeader('Content-Length', String(end - start + 1));
        fs.createReadStream(file, { start, end }).pipe(res);
        return res;
      }
    }
  }
  res.setHeader('Accept-Ranges', 'bytes');
  return fs.createReadStream(file).pipe(res);
}

async function removePost(user, id, { admin = false } = {}) {
  requireDb();
  const post = await socialStore.getPost(id, { withCountry: false });
  if (!post) throw new AuthError('not-found', 'That post no longer exists.', 404);
  if (!admin && post.creatorId !== user?.id) {
    throw new AuthError('forbidden', 'You can only delete your own posts.', 403);
  }
  await socialStore.deletePost(id);
  return post;
}

async function like(user, id, liked) {
  requireDb();
  requireUser(user);
  const post = await socialStore.getPost(id, { withCountry: false });
  if (!post || post.status === 'removed') throw new AuthError('not-found', 'That post is gone.', 404);
  if (post.isAdult && !isAdultAllowed(user)) {
    throw new AuthError('adult-only', 'This post is for accounts aged 18 and over.', 403);
  }
  return socialStore.likePost(id, user.id, Boolean(liked));
}

async function listComments(user, id) {
  requireDb();
  const post = await socialStore.getPost(id, { withCountry: false });
  if (!post || post.status === 'removed') throw new AuthError('not-found', 'That post is gone.', 404);
  if (post.isAdult && !isAdultAllowed(user)) {
    throw new AuthError('adult-only', 'This post is for accounts aged 18 and over.', 403);
  }
  return { items: await socialStore.listComments(id) };
}

async function addComment(user, id, body) {
  requireDb();
  requireUser(user);
  const post = await socialStore.getPost(id, { withCountry: false });
  if (!post || post.status === 'removed') throw new AuthError('not-found', 'That post is gone.', 404);
  if (post.isAdult && !isAdultAllowed(user)) {
    throw new AuthError('adult-only', 'This post is for accounts aged 18 and over.', 403);
  }
  const text = String(body ?? '').trim();
  if (!text) throw new AuthError('body', 'Write a comment first.', 400);
  return { comment: await socialStore.insertComment({ postId: id, accountId: user.id, username: user.username, body: text.slice(0, 500) }) };
}

// ── Charges (the STK push) ───────────────────────────────────────────────────

/**
 * Resolve what a charge is for: `{ payeeId, payeeUsername, amount, isAdult, owned }`.
 * Everything new on the platform routes through here, so a new paid thing
 * (say, a paid DM) only needs a new `purpose`.
 */
async function resolveTarget(user, purpose, refId) {
  if (purpose === 'post') {
    const post = await socialStore.getPost(refId, { withCountry: false });
    if (!post || post.status !== 'active') {
      throw new AuthError('not-found', 'That post is no longer available.', 404);
    }
    if (post.isAdult && !isAdultAllowed(user)) {
      throw new AuthError('adult-only', 'This content is for accounts aged 18 and over.', 403);
    }
    const owned = post.price <= 0 || post.creatorId === user.id || (await socialStore.isEntitled({
      purpose: 'post',
      refId: post.id,
      accountId: user.id,
    }));
    return {
      payeeId: post.creatorId,
      payeeUsername: post.creatorName,
      amount: post.price,
      currency: post.currency,
      label: post.caption || 'post',
      owned,
    };
  }

  if (purpose === 'room') {
    const room = await socialStore.getRoomById(refId);
    if (!room) throw new AuthError('not-found', 'That room is no longer available.', 404);
    if (room.status !== 'live') {
      throw new AuthError('room-ended', 'That room has ended.', 409);
    }
    if (room.isAdult && !isAdultAllowed(user)) {
      throw new AuthError('adult-only', '18+ rooms are for accounts aged 18 and over.', 403);
    }
    const owned = room.price <= 0 || room.hostId === user.id || (await socialStore.isEntitled({
      purpose: 'room',
      refId: room.id,
      accountId: user.id,
    }));
    return {
      payeeId: room.hostId,
      payeeUsername: room.hostName,
      amount: room.price,
      currency: room.currency,
      label: room.title,
      owned,
    };
  }

  throw new AuthError('purpose', 'Unknown payment type.', 400);
}

/**
 * Open a charge for one thing and, in `stk` mode, prompt the phone.
 *
 * Order matters: the row exists (with a null checkout id) before Daraja is
 * called, and the unique index on `checkout_request_id` is filled in right
 * after — so a callback arriving in the same millisecond still finds it.
 */
async function createCharge(user, { purpose, refId, phone } = {}) {
  requireDb();
  requireUser(user);
  if (!cfg().enabled) {
    throw new AuthError('payments-disabled', 'Paid content is switched off right now.', 409);
  }
  const target = await resolveTarget(user, purpose, Number(refId));
  if (target.owned) {
    throw new AuthError('already-owned', 'You have already paid for this.', 409);
  }
  const amount = target.amount <= 0 ? 0 : Math.round(target.amount);
  if (amount <= 0) {
    throw new AuthError('price', 'That item is free — nothing to pay for.', 400);
  }

  // Reuse an open charge: a double-tap on Pay must not start two STK pushes.
  const open = await socialStore.findOpenCharge({ purpose, refId: Number(refId), buyerId: user.id });
  const mpesaCfg = settings.get().mpesa;
  const useStk = Boolean(mpesaCfg.enabled && mpesaCfg.mode === 'stk');

  let charge = open;
  if (!charge) {
    const { commission, net } = split(amount);
    charge = await socialStore.insertCharge({
      purpose,
      refId: Number(refId),
      buyerId: user.id,
      buyerUsername: user.username,
      payeeId: target.payeeId,
      payeeUsername: target.payeeUsername,
      phone: mpesa.normalizePhone(phone) || '',
      amount,
      currency: target.currency || cfg().currency,
      commission,
      net,
    });
  }

  if (!useStk) {
    // Manual mode: the row is the request; the owner approves it after
    // seeing the money on the statement (same ritual as the paybill ledger).
    return { charge: { ...charge, instructions: manualInstructions(charge, user) } };
  }

  try {
    const ids = await mpesa.stkPush({
      phone: phone || charge.phone,
      amount,
      accountRef: `MU${user.id}`,
      description: target.label,
    });
    const rows = await mariaStore.query(
      'UPDATE charges SET checkout_request_id = ?, merchant_request_id = ?, phone = ? WHERE id = ? AND status = \'pending\'',
      [ids.checkoutRequestId, ids.merchantRequestId, mpesa.normalizePhone(phone), charge.id],
    );
    if (!rows.affectedRows) {
      // Settled or failed while the push was in flight — report the truth.
      return { charge: await socialStore.getCharge(charge.id) };
    }
  } catch (err) {
    await socialStore.markChargeFailed(charge.id, {
      resultDesc: err.message,
      note: 'stk push rejected',
    });
    throw err instanceof AuthError
      ? err
      : new AuthError(err.code || 'stk-failed', err.message, 502);
  }

  return { charge: await socialStore.getCharge(charge.id) };
}

function manualInstructions(charge, user) {
  const m = settings.get().mpesa;
  const reference = settings.renderAccountNo(m.accountFormat, { id: user.id, username: user.username });
  const parts = [
    m.paybill
      ? `Pay KES ${charge.amount} to paybill ${m.paybill}, account number ${reference}.`
      : `Pay KES ${charge.amount} using your bank or M-PESA app, reference ${reference}.`,
    'Then wait — the owner confirms the payment and your access opens automatically.',
  ];
  return parts.join(' ');
}

/**
 * Read one charge back, settling it if Daraja already knows the answer.
 *
 * The client polls this every 3s; the callback usually lands first, but a
 * lost callback must not leave a paid user staring at "pending" forever.
 */
async function chargeStatus(user, id) {
  requireDb();
  requireUser(user);
  const charge = await socialStore.getCharge(id);
  if (!charge || charge.buyerId !== user.id) {
    throw new AuthError('not-found', 'That payment does not exist.', 404);
  }

  if (charge.status === 'pending') {
    const m = settings.get().mpesa;
    if (m.enabled && m.mode === 'stk' && charge.checkoutRequestId) {
      // Give the callback a head start — asking Daraja on every poll hammers
      // the query endpoint for no reason.
      const ageMs = Date.now() - Date.parse(charge.createdAt);
      if (ageMs > 6000) {
        const result = await mpesa.queryStatus(charge.checkoutRequestId).catch(() => null);
        if (result?.complete) {
          if (result.resultCode === 0) {
            await settle(charge.id, { receipt: result.receipt, resultCode: 0, description: result.description });
          } else {
            await fail(charge.id, { resultCode: result.resultCode, description: result.description });
          }
          return { charge: await socialStore.getCharge(charge.id) };
        }
      }
    }
    // Sweep anything past the STK lifetime so "pending" cannot linger forever.
    if (ageExpired(charge)) {
      await socialStore.markChargeFailed(charge.id, { resultDesc: 'Request timed out', note: 'expired' });
      return { charge: await socialStore.getCharge(charge.id) };
    }
  }

  return { charge };
}

/** STK requests die after 5 minutes; manual requests get longer to be paid. */
const ageExpired = (charge) => {
  const age = Date.now() - Date.parse(charge.createdAt);
  return charge.checkoutRequestId ? age > 5 * 60_000 : age > 15 * 60_000;
};

/**
 * The settlement: paid row → creator's wallet, exactly once.
 * Safe to call from the callback, a status poll and an admin approval — the
 * first one wins the `pending → paid` UPDATE and credits; the rest no-op.
 *
 * @returns {Promise<boolean>} true when this call moved the money
 */
async function settle(chargeId, { receipt = null, resultCode = 0, description = null } = {}) {
  const charge = await socialStore.getCharge(chargeId);
  if (!charge) return false;

  const won = await socialStore.markChargePaid(charge.id, {
    receipt,
    resultCode,
    resultDesc: description,
  });
  if (!won) return false;

  await socialStore.creditWallet(charge.payeeId, charge.net, {
    kind: 'sale',
    chargeId: charge.id,
    memo: `${charge.purpose === 'post' ? 'Post' : 'Room'} sale → ${charge.buyerUsername}`,
  });
  if (charge.purpose === 'post') {
    mariaStore
      .query('UPDATE posts SET purchases = purchases + 1 WHERE id = ?', [charge.refId])
      .catch(() => undefined);
  }
  return true;
}

async function fail(chargeId, { resultCode = null, description = null, note = null } = {}) {
  return socialStore.markChargeFailed(chargeId, { resultCode, resultDesc: description, note });
}

// ── Wallet ───────────────────────────────────────────────────────────────────

async function wallet(user) {
  requireDb();
  requireUser(user);
  const [walletRow, entries] = await Promise.all([
    socialStore.getWallet(user.id),
    socialStore.listWalletEntries({ accountId: user.id, size: 50 }),
  ]);
  return { wallet: walletRow, entries: entries.items };
}

/**
 * Request a payout: the amount is reserved immediately (the balance can never
 * go negative) and the owner approves it from `/admin` → Earnings.
 */
async function withdraw(user, { phone, amount } = {}) {
  requireDb();
  requireUser(user);
  const value = Math.round(Number(amount) || 0);
  if (value < 100) {
    throw new AuthError('amount', 'The minimum payout is KES 100.', 400);
  }
  const normalized = mpesa.normalizePhone(phone);
  if (!mpesa.isValidPhone(normalized)) {
    throw new AuthError('phone', 'Enter the M-PESA number to receive the payout, e.g. 0712 345 678.', 400);
  }
  const entry = await socialStore.reserveWithdrawal(user.id, value, { phone: normalized });
  if (!entry) {
    throw new AuthError('insufficient', 'That is more than your available balance.', 400);
  }
  return { entry };
}

// ── Rooms ────────────────────────────────────────────────────────────────────

async function createRoom(user, input = {}) {
  requireDb();
  requireUser(user);
  requireEnabled('groups', 'Group calls are switched off right now.');

  const c = cfg();
  const kind = input.kind === 'conference' ? 'conference' : 'group';
  const isAdult = Boolean(input.isAdult);
  if (isAdult) {
    if (!c.adult) {
      throw new AuthError('adult-disabled', '18+ rooms are switched off on this platform.', 409);
    }
    if (!isAdultAllowed(user)) {
      throw new AuthError('adult-only', '18+ rooms are for accounts aged 18 and over.', 403);
    }
  }
  const title = String(input.title ?? '').trim().slice(0, 80);
  if (!title) throw new AuthError('title', 'Give the room a title.', 400);

  let price = Math.round(Number(input.price) || 0);
  if (price > 0) price = Math.min(c.maxPrice, Math.max(c.minPrice, price));

  return socialStore.insertRoom({
    title,
    kind,
    hostId: user.id,
    hostUsername: user.username,
    price,
    currency: c.currency,
    isAdult,
    maxParticipants: Number(input.max) || (kind === 'conference' ? 8 : 6),
  });
}

async function rooms(user, { kind, adult } = {}) {
  requireDb();
  const wantsAdult = adult === true || adult === '1' || adult === 1;
  const showAdult = wantsAdult && isAdultAllowed(user);
  const result = await socialStore.listRooms({
    kind: kind === 'conference' ? 'conference' : kind === 'group' ? 'group' : '',
    status: 'live',
    adult: showAdult ? null : false,
  });
  return { items: result.items };
}

/** `{ entitled, canEnter, reason }` — the gate `rooms.js` calls on entry. */
async function roomAccess(user, room) {
  if (!user || typeof user.id !== 'number') {
    return { entitled: false, canEnter: false, reason: 'unauthorized' };
  }
  if (!cfg().enabled || !cfg().groups) {
    return { entitled: false, canEnter: false, reason: 'groups-disabled' };
  }
  if (room.status !== 'live') return { entitled: false, canEnter: false, reason: 'room-ended' };
  if (room.isAdult && !isAdultAllowed(user)) {
    return { entitled: false, canEnter: false, reason: 'adult-only' };
  }
  if (room.hostId === user.id) return { entitled: true, canEnter: true };
  if (room.price <= 0) return { entitled: true, canEnter: true };
  const entitled = await socialStore.isEntitled({
    purpose: 'room',
    refId: room.id,
    accountId: user.id,
  });
  return entitled
    ? { entitled: true, canEnter: true }
    : { entitled: false, canEnter: false, reason: 'payment-required' };
}

async function roomInfo(user, slug) {
  requireDb();
  const room = await socialStore.getRoomBySlug(slug);
  if (!room) throw new AuthError('not-found', 'That room does not exist.', 404);
  if (room.isAdult && !isAdultAllowed(user)) {
    throw new AuthError('adult-only', '18+ rooms are for accounts aged 18 and over.', 403);
  }
  const access = await roomAccess(user, room);
  return {
    room,
    entitled: access.entitled,
    canEnter: access.canEnter,
    reason: access.reason ?? null,
  };
}

module.exports = {
  init,
  backend,
  split,
  isAdultAllowed,
  // posts
  saveUpload,
  createPost,
  feed,
  mine,
  postDetail,
  readPostMedia,
  removePost,
  like,
  listComments,
  addComment,
  // charges
  createCharge,
  chargeStatus,
  settle,
  fail,
  // wallet
  wallet,
  withdraw,
  // rooms
  createRoom,
  rooms,
  roomInfo,
  roomAccess,
};
