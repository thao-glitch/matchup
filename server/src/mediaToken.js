/**
 * Signed, post-scoped claims for gated media URLs.
 *
 * Why this exists: `<img>` / `<video>` tags fetch their `src` without any
 * custom header, so the Bearer token the rest of the API uses can never reach
 * `GET /api/posts/:id/media`. A viewer who *is* entitled (the creator, or a
 * buyer whose charge settled) would still get 402 and a broken picture — the
 * paywall worked, but the unlock never showed.
 *
 * The fix keeps enforcement where it was: the media route still decides. What
 * changes is that a gated `mediaUrl` now carries `?t=<claim>` — an HMAC-bound
 * statement "this URL was minted for account X (adult: yes/no) on post Y,
 * valid until T". The route verifies the signature, then re-checks ownership
 * live (post still active, buyer still entitled), so a revoked purchase or a
 * deleted post takes effect immediately even though the URL lives in an
 * open page.
 *
 * The key is `MEDIA_TOKEN_SECRET` when set (stable across restarts, and the
 * only setting needed if the app is ever scaled to more than one instance —
 * otherwise a minted URL dies with the instance that made it), and a random
 * per-boot value otherwise: no configuration is required for it to be safe,
 * and a restart simply invalidates links that the next list fetch re-mints.
 *
 * TTL is one hour: every API response mints fresh claims, so the only URLs
 * that can go stale are ones on a page that stayed mounted untouched for an
 * hour — and those heal on the next navigation.
 */
const crypto = require('crypto');

const TTL_MS = Number(process.env.MEDIA_TOKEN_TTL_MS) || 60 * 60 * 1000;

let key = process.env.MEDIA_TOKEN_SECRET || null;
function secret() {
  if (!key) key = crypto.randomBytes(32).toString('base64url');
  return key;
}

const mac = (body) =>
  crypto.createHmac('sha256', secret()).update(body).digest('base64url').slice(0, 32);

/**
 * Mint the `t` query value for one viewer + one post.
 *
 * @param {number} postId   the post the claim is bound to
 * @param {number} accountId the viewer (0 only for signed-out readers of free
 *                           posts, which need no claim at all)
 * @param {boolean} adult   whether the viewer passed the18+ gate at mint time
 */
function mint(postId, accountId, adult) {
  const body = `${Number(postId)}.${Number(accountId) || 0}.${adult ? 1 : 0}.${Date.now() + TTL_MS}`;
  return `${body}.${mac(body)}`;
}

/**
 * Verify a claim for a given post.
 *
 * @returns {{ accountId: number, adult: boolean } | null} null for anything
 *          tampered with, for another post's claim, or once expired.
 */
function verify(postId, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 5) return null;
  const [pid, acc, adult, exp, sig] = parts;
  if (Number(pid) !== Number(postId)) return null;

  const body = `${pid}.${acc}.${adult}.${exp}`;
  const want = Buffer.from(mac(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  if (!Number.isFinite(Number(exp)) || Number(exp) < Date.now()) return null;

  return { accountId: Number(acc) || null, adult: adult === '1' };
}

module.exports = { mint, verify, TTL_MS };
