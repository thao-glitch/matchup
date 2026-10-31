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
const mediaToken = require('./mediaToken');
const settings = require('./settings');
const accounts = require('./accounts');
const mpesa = require('./mpesa');
const mediaStore = require('./mediaStore');

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

/**
 * The house, as a payee. Premium is the only charge nobody on the platform
 * earns — the money goes to the owner's collection account — but the schema
 * wants a payee on every row, so it is one stable, never-used account id.
 */
const HOUSE_PAYEE = { id: 0, username: 'matchup' };

/** A `premium_until` that has not run out yet. */
function premiumActive(iso) {
  if (!iso) return false;
  const until = new Date(iso).getTime();
  return Number.isFinite(until) && until > Date.now();
}

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

/**
 * Every payment on the platform is an STK push — there is no manual path left
 * to fall back to, so an unconfigured Daraja has to stop the charge before a
 * row is written, not after a prompt that will never arrive.
 */
function requireStk() {
  if (mpesa.isConfigured()) return;
  const m = settings.get().mpesa;
  const missing = !m.consumerKey || !m.consumerSecret
    ? 'the consumer key and secret'
    : !m.shortcode
      ? 'the shortcode'
      : !m.passkey
        ? 'the Lipa na M-PESA passkey'
        : 'turning M-PESA on';
  throw new AuthError(
    'mpesa-not-configured',
    `M-PESA cannot take a payment yet — ${missing} is still missing in Settings. ` +
      'Test the connection from the dashboard to see exactly what is outstanding.',
    503,
  );
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
 * this validates the type and files them under a random key. Private object
 * storage is used first when configured; MariaDB (`media_blobs`) and the
 * plain filesystem remain as local/development fallbacks.
 *
 * @returns {Promise<string>} the key to hand to `POST /api/posts`
 */
async function saveUpload({ buffer, contentType }) {
  requireDb();
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  const ext = MEDIA_TYPES[mime];
  if (!ext) {
    throw new AuthError('media-type', 'Upload an image (JPEG, PNG, WebP, GIF) or a video (MP4, WebM).', 415);
  }
  if (!buffer || !buffer.length) {
    throw new AuthError('media-empty', 'That file is empty — choose another one.', 400);
  }
  const key = `${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}${ext}`;
  // Object storage first: the database is for metadata, not media bytes.
  if (await mediaStore.save(key, mime, buffer)) return key;
  if (backend === 'maria') {
    await mariaStore.saveMediaBlob(key, mime, buffer);
    return key;
  }
  await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(UPLOAD_DIR, key), buffer);
  return key;
}

const safeKey = (key) => /^[A-Za-z0-9._-]{4,80}$/.test(String(key || ''));
const MEDIA_EXTENSIONS = new Set(Object.values(MEDIA_TYPES));

/** Validate a client-generated direct-upload key before issuing a Blob token. */
function isMediaKey(key) {
  const value = String(key || '');
  return safeKey(value) && [...MEDIA_EXTENSIONS].some((ext) => value.endsWith(ext));
}

function mediaContentTypes() {
  return Object.keys(MEDIA_TYPES);
}

/** Blob first, then the historical DB row, then the legacy disk file. */
async function mediaExists(key) {
  if (!safeKey(key)) return false;
  try {
    if (await mediaStore.exists(key)) return true;
  } catch {
    /* object storage unavailable — fall through to the durable fallbacks */
  }
  if (backend === 'maria') {
    const blob = await mariaStore.getMediaBlob(key);
    return Boolean(blob);
  }
  return fs.existsSync(path.join(UPLOAD_DIR, key));
}

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
    if (!(await mediaExists(mediaKey))) {
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
async function feed(user, { page, size, q, adult, creatorId } = {}) {
  requireDb();
  const wantsAdult = adult === true || adult === '1' || adult === 1;
  // The adult shelf only exists for signed-in adults — regardless of the switch.
  const showAdult = wantsAdult && isAdultAllowed(user);
  const result = await socialStore.listPosts({
    page,
    size,
    q,
    adult: showAdult,
    creatorId: creatorId ? Number(creatorId) : null,
  });
  const items = await socialStore.decorateForViewer(
    result.items,
    user?.id ?? null,
    isAdultAllowed(user),
  );
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
  const items = await socialStore.decorateForViewer(result.items, user.id, isAdultAllowed(user));
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
    ? (await socialStore.decorateForViewer([{ ...post, owned }], user.id, isAdultAllowed(user)))[0]
        .liked
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
      // Paid media gets the signed claim an <img>/`<video>` tag can carry —
      // see `mediaToken.js`; free media needs no credentials at all.
      mediaUrl:
        owned && post.mediaKey
          ? `/api/posts/${post.id}/media${
              post.price > 0 && user ? `?t=${mediaToken.mint(post.id, user.id, isAdultAllowed(user))}` : ''
            }`
          : null,
    },
  };
}

/**
 * Stream the media file behind a post — the paywall's enforcement point.
 * Files are never exposed statically, so this is the only way in.
 *
 * `token` is the signed `?t=` claim from a gated list/detail response: an
 * <img> tag cannot authenticate any other way. It proves *who* the URL was
 * minted for; everything it grants is still re-checked here against the live
 * rows (post active, buyer still entitled, adult gate), so the claim is an
 * identity for the request, never a bypass of the rules.
 */
async function readPostMedia(user, id, res, token) {
  requireDb();
  if (!Number.isInteger(id) || id <= 0) {
    throw new AuthError('not-found', 'No media on that post.', 404);
  }
  const post = await socialStore.getPost(id, { withCountry: false });
  if (!post || post.status === 'removed' || !post.mediaKey) {
    throw new AuthError('not-found', 'No media on that post.', 404);
  }
  const claim = token ? mediaToken.verify(id, token) : null;
  const viewerId = user?.id ?? claim?.accountId ?? null;
  // A Bearer request is evaluated live; a claim carries the18+ verdict it was
  // minted with (the route only ever mints after that viewer passed the gate).
  const adultOk = user ? isAdultAllowed(user) : Boolean(claim?.adult);
  if (post.isAdult && !adultOk) {
    throw new AuthError('adult-only', 'This post is for accounts aged 18 and over.', 403);
  }
  const owned =
    post.price <= 0 ||
    (viewerId !== null && post.creatorId === viewerId) ||
    (viewerId !== null &&
      (await socialStore.isEntitled({ purpose: 'post', refId: post.id, accountId: viewerId })));
  if (!owned) {
    throw new AuthError('payment-required', 'Pay to unlock this post.', 402);
  }

  const key = path.basename(post.mediaKey);
  const mimeFor = (value) =>
    Object.entries(MEDIA_TYPES).find(([, ext]) => value.endsWith(ext))?.[0] ||
    'application/octet-stream';

  let data = null;
  let type = mimeFor(key);
  try {
    const stored = await mediaStore.read(key);
    if (stored?.data) {
      data = stored.data;
      type = stored.mime || type;
    }
  } catch (err) {
    console.warn('[commerce] blob read failed:', err.message);
  }

  if (!data && backend === 'maria') {
    const blob = await mariaStore.getMediaBlob(key);
    if (blob?.data) {
      data = Buffer.isBuffer(blob.data) ? blob.data : Buffer.from(blob.data);
      type = blob.mime || type;
    }
  }

  if (!data && backend !== 'maria') {
    const file = path.join(UPLOAD_DIR, key);
    if (safeKey(key) && fs.existsSync(file)) data = await fs.promises.readFile(file);
  }

  if (!data) {
    throw new AuthError('not-found', 'That file is missing — the creator can re-upload it.', 404);
  }

  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', String(data.length));
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.setHeader('Accept-Ranges', 'bytes');
  const range = res.req.headers.range;
  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : data.length - 1;
      if (start < data.length) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${data.length}`);
        res.setHeader('Content-Length', String(end - start + 1));
        return res.end(data.subarray(start, end + 1));
      }
    }
  }
  return res.end(data);
}

async function removePost(user, id, { admin = false } = {}) {
  requireDb();
  const post = await socialStore.getPost(id, { withCountry: false });
  if (!post) throw new AuthError('not-found', 'That post no longer exists.', 404);
  if (!admin && post.creatorId !== user?.id) {
    throw new AuthError('forbidden', 'You can only delete your own posts.', 403);
  }
  await socialStore.deletePost(id);
  // Best-effort media cleanup — a failed sweep must not fail the delete.
  try {
    if (post.mediaKey) {
      const key = path.basename(post.mediaKey);
      await mediaStore.remove(key).catch(() => undefined);
      if (backend === 'maria') {
        await mariaStore.deleteMediaBlob(key);
      } else {
        await fs.promises.unlink(path.join(UPLOAD_DIR, key)).catch(() => undefined);
      }
    }
  } catch (err) {
    console.warn('[commerce] media cleanup failed:', err.message);
  }
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

// ── Creators: follow + subscribe ─────────────────────────────────────────────

/** Public creator card — profile, audience counts, offer and viewer state. */
async function creator(user, id) {
  requireDb();
  const found = await socialStore.getCreator(id, user?.id ?? null);
  if (!found) throw new AuthError('not-found', 'That creator does not exist.', 404);
  return { creator: found };
}

async function follow(user, id, following = true) {
  requireDb();
  requireUser(user);
  const found = await socialStore.getCreator(id, user.id);
  if (!found) throw new AuthError('not-found', 'That creator does not exist.', 404);
  if (found.banned) throw new AuthError('banned', 'That account is unavailable.', 403);
  if (found.viewer.isSelf) {
    throw new AuthError('self', 'You cannot follow yourself.', 400);
  }
  return socialStore.followCreator(user.id, id, Boolean(following));
}

/** The creator's own offer: free or paid, how much, how long, what they get. */
async function updateCreatorSubscription(user, patch = {}) {
  requireDb();
  requireUser(user);
  requireEnabled('social', 'Subscriptions are switched off right now.');
  const c = cfg();
  let price = Math.round(Number(patch.price) || 0);
  if (price > 0) price = Math.min(c.maxPrice, Math.max(c.minPrice, price));
  const periodDays = Math.min(365, Math.max(1, Math.trunc(Number(patch.periodDays) || 30)));
  const perk = String(patch.perk ?? '').trim().slice(0, 160);
  const offer = await socialStore.putCreatorSub(user.id, {
    enabled: Boolean(patch.enabled),
    price,
    currency: c.currency,
    periodDays,
    perk,
  });
  return { subscription: offer };
}

async function myCreatorSubscription(user) {
  requireDb();
  requireUser(user);
  return { subscription: await socialStore.getCreatorSub(user.id) };
}

/**
 * Subscribe to a creator. Free offers activate immediately; a priced offer
 * opens the same M-PESA STK charge as a post or a room, and settlement
 * activates the subscription exactly once.
 */
async function subscribe(user, id, { phone } = {}) {
  requireDb();
  requireUser(user);
  requireEnabled('social', 'Subscriptions are switched off right now.');
  const found = await socialStore.getCreator(id, user.id);
  if (!found) throw new AuthError('not-found', 'That creator does not exist.', 404);
  if (found.banned) throw new AuthError('banned', 'That account is unavailable.', 403);
  if (found.viewer.isSelf) {
    throw new AuthError('self', 'You cannot subscribe to yourself.', 400);
  }
  if (!found.subscription.enabled) {
    throw new AuthError('subscriptions-off', 'This creator is not taking subscribers.', 409);
  }
  if (found.viewer.subscribed) {
    throw new AuthError('already-subscribed', 'You already subscribe to this creator.', 409);
  }

  if (found.subscription.price <= 0) {
    const subscription = await socialStore.activateSubscription({
      subscriberId: user.id,
      creatorId: found.id,
      price: 0,
      currency: found.subscription.currency,
      periodDays: found.subscription.periodDays,
    });
    return { subscription, charge: null };
  }

  const opened = await createCharge(user, { purpose: 'sub', refId: found.id, phone });
  return { ...opened, subscription: null };
}

/** Stop renewing; access remains until the paid period ends. */
async function cancelSubscription(user, id) {
  requireDb();
  requireUser(user);
  const current = await socialStore.getSubscription(user.id, id);
  if (!current) throw new AuthError('not-found', 'You are not subscribed to that creator.', 404);
  return { subscription: await socialStore.cancelSubscription(user.id, id) };
}

// ── Charges (the STK push) ───────────────────────────────────────────────────

/**
 * Resolve what a charge is for: `{ payeeId, payeeUsername, amount, owned, … }`.
 * Everything on the platform routes through here, so a new paid thing (say, a
 * paid DM) only needs a new `purpose`.
 *
 * Three purposes exist: `post` and `room` pay a creator; `premium` pays the
 * house and carries its own `premiumDays`.
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

  if (purpose === 'sub') {
    const creator = await socialStore.getCreator(refId, user.id);
    if (!creator) throw new AuthError('not-found', 'That creator does not exist.', 404);
    if (creator.banned) throw new AuthError('banned', 'That account is unavailable.', 403);
    if (creator.viewer.isSelf) {
      throw new AuthError('self', 'You cannot subscribe to yourself.', 400);
    }
    if (!creator.subscription.enabled) {
      throw new AuthError('subscriptions-off', 'This creator is not taking subscribers.', 409);
    }
    return {
      payeeId: creator.id,
      payeeUsername: creator.username,
      amount: creator.subscription.price,
      currency: creator.subscription.currency,
      label: `Subscription · @${creator.username}`,
      owned: creator.viewer.subscribed,
      periodDays: creator.subscription.periodDays,
    };
  }

  if (purpose === 'premium') {
    const p = settings.get().payment;
    if (!p.enabled || !settings.get().features.premium) {
      throw new AuthError('payments-disabled', 'Premium is switched off right now.', 409);
    }
    // Buying more premium while some is already running is the one thing worth
    // refusing: the price is a fixed subscription, not a top-up, and an open
    // "extend" button next to an active one is how double charges happen.
    const owned = premiumActive(user.premiumUntil);
    return {
      // The house is the payee: there is no creator wallet to credit, the
      // money lands in the collection account the owner settles to their own
      // M-PESA number. `HOUSE_PAYEE` keeps the column's NOT NULL honest.
      payeeId: HOUSE_PAYEE.id,
      payeeUsername: HOUSE_PAYEE.username,
      amount: p.amount,
      currency: p.currency,
      label: p.productName,
      owned,
      premiumDays: Math.max(1, Math.trunc(Number(p.premiumDays) || 30)),
    };
  }

  throw new AuthError('purpose', 'Unknown payment type.', 400);
}

/**
 * Open a charge for one thing and prompt the phone.
 *
 * Order matters: the row exists (with a null checkout id) before Daraja is
 * called, and the unique index on `checkout_request_id` is filled in right
 * after — so a callback arriving in the same millisecond still finds it.
 */
async function createCharge(user, { purpose, refId, phone } = {}) {
  requireDb();
  requireUser(user);
  // The social platform's master switch governs posts and rooms. Premium is
  // bought from the lobby, not the feed, so it answers to its own switch —
  // turning paid content off must not silently stop people renewing.
  if (purpose === 'premium') {
    if (!settings.get().payment.enabled) {
      throw new AuthError('payments-disabled', 'Premium purchases are switched off right now.', 409);
    }
  } else if (!cfg().enabled) {
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
  requireStk();

  let charge = open;
  if (!charge) {
    // Premium is the whole house take — there is no creator to split with.
    const { commission, net } = purpose === 'premium' ? { commission: amount, net: 0 } : split(amount);
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
      premiumDays: target.premiumDays ?? null,
      periodDays: target.periodDays ?? null,
    });
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
    if (charge.checkoutRequestId) {
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

/** An STK request dies after 5 minutes — Daraja stops honouring it by then. */
const ageExpired = (charge) => Date.now() - Date.parse(charge.createdAt) > 5 * 60_000;

/**
 * The settlement: paid row → whatever the charge bought, exactly once.
 * Safe to call from the callback, a status poll and an admin approval — the
 * first one wins the `pending → paid` UPDATE and acts; the rest no-op.
 *
 *   `premium` → stamps `premium_until` on the BUYER (they bought time, not
 *               credit) using the period quoted when the prompt was sent;
 *   `post` / `room` → credits the creator's wallet with the net share.
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

  if (charge.purpose === 'premium') {
    const days = Number.isFinite(charge.premiumDays)
      ? charge.premiumDays
      : Number(settings.get().payment.premiumDays) || 30;
    await mariaStore.updateUserFlags(charge.buyerId, { premiumDays: days });
  } else if (charge.purpose === 'sub') {
    const periodDays = Number.isFinite(charge.periodDays) ? charge.periodDays : 30;
    await socialStore.activateSubscription({
      subscriberId: charge.buyerId,
      creatorId: charge.refId,
      chargeId: charge.id,
      price: charge.amount,
      currency: charge.currency,
      periodDays,
    });
    await socialStore.creditWallet(charge.payeeId, charge.net, {
      kind: 'sale',
      chargeId: charge.id,
      memo: `Subscription sale → ${charge.buyerUsername}`,
    });
  } else {
    await socialStore.creditWallet(charge.payeeId, charge.net, {
      kind: 'sale',
      chargeId: charge.id,
      memo: `${charge.purpose === 'post' ? 'Post' : 'Room'} sale → ${charge.buyerUsername}`,
    });
  }
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
  isMediaKey,
  mediaContentTypes,
  createPost,
  feed,
  mine,
  postDetail,
  readPostMedia,
  removePost,
  like,
  listComments,
  addComment,
  // creators
  creator,
  follow,
  updateCreatorSubscription,
  myCreatorSubscription,
  subscribe,
  cancelSubscription,
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
