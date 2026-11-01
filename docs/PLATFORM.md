# Matchup Social Platform — contracts

The social upgrade on top of the 1v1 video app. The video app is untouched;
everything here is additive. This file is the single source of truth for the
wire shapes shared by `server/`, `client/` and `client/src/admin/`.

---

## 1. Money model

A **creator sets a price** on content (posts) or on a room (group call /
conference). A viewer pays with **M-PESA STK push**: they enter their phone
number, press **Pay**, Safaricom prompts their phone, they type their PIN.

```
gross (KES)  = price the creator set
commission   = round(gross × commerce.commissionRate / 100)   ← the platform's cut ("tax")
net          = gross − commission                             ← credited to the creator's wallet
```

The platform keeps `commission` on every settled charge. Creators see the
split before they set a price and in their wallet.

Every payment — premium, a post, a room — is a Daraja **STK push**: the phone
prompts for the PIN and the callback settles the charge. There is no manual
mode any more, so a charge only ever leaves `pending` by being settled (by
the callback, by a poll, or by the owner clicking settle on a callback that
never arrived).

Settings docs (all edited through `PUT /api/admin/settings`):

```jsonc
// key: "commerce"
{
  "enabled": true,       // master switch for all paid content
  "social": true,        // posts/feed
  "groups": true,        // group calls + conferences
  "adult": true,         // 18+ content allowed at all
  "commissionRate": 15,  // 0–50, percent the platform keeps
  "minPrice": 5,         // smallest price a creator may set (KES)
  "maxPrice": 15000,
  "currency": "KES"
}

// key: "mpesa"
{
  "enabled": false,
  "consumerKey": "",              // Daraja — masked as "••••" on read
  "consumerSecret": "",           // masked
  "shortcode": "",                // your Paybill — required, e.g. 174379 (sandbox)
  "passkey": "",                  // masked — the Lipa na M-PESA Online passkey
  "baseUrl": "https://sandbox.safaricom.co.ke",
  "callbackUrl": "",              // https://<host>/api/mpesa/callback
  "description": "Matchup"
}
```

Without a `shortcode` and `passkey` no charge can be opened at all —
`createCharge` refuses with `mpesa-not-configured` before writing a row,
because a prompt that could never be sent must not leave a pending charge
behind. `/admin` → Settings → **Test connection** reports which requirement
is outstanding and can fire a real KES 1 prompt to prove it end to end.

`GET /api/config` additionally returns a **public** `commerce` block:

```jsonc
commerce: {
  enabled, social, groups, adult, commissionRate, minPrice, maxPrice, currency,
  mpesaReady: false   // credentials + shortcode + passkey all present
}
```
```

No secrets ever leave the server. Secrets written back containing `••••` are
ignored (the stored value wins), so a masked value round-trips safely.

---

## 2. Database (all created idempotently in `mariaStore.applySchema`)

```sql
posts(id, account_id, username, type, caption, media_key, link_url,
      price DECIMAL(10,2), currency, is_adult, status, views, likes_n, comments_n,
      purchases, created_at)                       -- no FK: content rows outlive accounts
post_likes(post_id, account_id, created_at, PRIMARY KEY(post_id, account_id))
post_comments(id, post_id, account_id, username, body, status, created_at)
charges(id, purpose, ref_id, buyer_account_id, buyer_username, payee_account_id,
        payee_username, phone, amount, currency, commission, net, status,
        checkout_request_id, merchant_request_id, mpesa_receipt, result_code,
        result_desc, note, created_at, paid_at)
wallets(account_id PK, balance, lifetime_in, lifetime_out, updated_at)
wallet_entries(id, account_id, amount, kind, status, charge_id, memo, created_at)
rooms(id, slug UNIQUE, title, kind, host_account_id, host_username, price,
      currency, is_adult, max_participants, status, created_at, ended_at)
follows(follower_id, creator_id, created_at, PRIMARY KEY(follower_id, creator_id))
creator_subs(account_id PK, enabled, price, currency, period_days, perk, updated_at)
subscriptions(id, subscriber_id, creator_id, status, price, currency, period_days,
              charge_id, started_at, expires_at, canceled_at,
              UNIQUE(subscriber_id, creator_id))
```

* `charges` is the payment instrument for **everything new** (purpose:
  `post` | `room` | `sub` | `premium`) — entitlement = a `paid` charge for
  that `ref_id` and buyer. A `sub` charge points at the creator account and
  carries the quoted `period_days`.
* A creator decides whether subscriptions are off, free, or paid
  (`creator_subs`). An active `subscriptions` row unlocks every paid post by
  that creator; rooms and platform premium stay charge-only.
* Post responses carry `creatorFollowing`, `creatorSubscribed` and
  `creatorSubscription`, so the feed, explore and post-detail cards can offer
  Follow / Subscribe without an extra creator fetch.
* No account FK on `charges` (money outlives users), same rule as `payments`.
* `wallet_entries.kind`: `sale` | `adjustment` | `withdrawal`;
  `status`: `posted` | `pending` | `approved` | `rejected`.
* Media bytes live in a **private Vercel Blob store** when
  `BLOB_READ_WRITE_TOKEN` is configured (production); otherwise they fall back
  to `media_blobs` in MariaDB (local dev / no object storage). The browser
  uploads directly to Blob through `POST /api/media/direct` (a short-lived
  client token), so a 32 MB video never has to pass through a serverless
  function's request-body limit. `media_key` remains the only link in MariaDB.
  Media is **only** served through `GET /api/posts/:id/media`, which enforces
  the paywall. A *paid* post's
  `mediaUrl` carries `?t=<claim>` — a signed, post-scoped, 1h statement of who
  the URL was minted for (`src/mediaToken.js`). An `<img>`/`<video>` tag cannot
  send a Bearer header, so the claim is the only credential the media route
  will see from one; it authenticates the viewer, and the route still re-checks
  ownership live, so the claim is never a bypass. Bearer requests work too.
* Blob has no native per-object TTL. The app-level lifecycle sweep keeps every
  `posts.media_key`, deletes unreferenced Blob objects older than
  `MEDIA_ORPHAN_GRACE_HOURS` (default 24h), and removes unreferenced legacy
  `media_blobs` rows older than `MEDIA_RETENTION_DAYS` (default 30d). It runs
  daily via `GET /api/cron/media` (Vercel Cron + `CRON_SECRET`) and manually
  from the admin Database panel. See `docs/SCALING.md`.

---

## 3. User API (Bearer auth, `{ error: { code, message } }` on failure)

### Posts
| Method | Path | Body / query | → |
| --- | --- | --- | --- |
| GET | `/api/posts` | `?page&size&q&adult=0\|1&creatorId=` | `{ items: Post[], total, page, size }` |
| GET | `/api/posts/mine` | `?page&size` | same, own posts incl. hidden |
| GET | `/api/posts/:id` | | `{ post: Post }` (counts a view) |
| GET | `/api/posts/:id/media` | `?t=<claim>` for paid media | binary, or 401/402 JSON |
| POST | `/api/posts` | `{ caption, price, isAdult, type, mediaKey?, linkUrl? }` | 201 `{ post }` |
| DELETE | `/api/posts/:id` | | 204 (owner) |
| POST | `/api/posts/:id/like` | `{ liked: boolean }` | `{ liked, likes }` |
| GET | `/api/posts/:id/comments` | | `{ items: Comment[] }` |
| POST | `/api/posts/:id/comments` | `{ body }` | 201 `{ comment }` |
| POST | `/api/media` | raw bytes, `Content-Type: image/* \| video/mp4` | 201 `{ key }` (max 32 MB; legacy/small uploads) |
| POST | `/api/media/direct` | Bearer + `{ type, payload }` from `@vercel/blob/client` | Blob client token / upload-completed acknowledgement |

```ts
interface Post {
  id: number; creatorId: number; creatorName: string; creatorCountry: string;
  type: 'image' | 'video' | 'link' | 'text';
  caption: string;
  mediaUrl: string | null;   // `/api/posts/<id>/media` (+ `?t=` when paid) when the viewer may see it, else null
  linkUrl: string | null;
  price: number; currency: string;
  isAdult: boolean; status: 'active' | 'hidden' | 'removed';
  views: number; likes: number; comments: number; purchases: number;
  liked: boolean; owned: boolean;
  createdAt: string;         // ISO
}
interface Comment { id: number; postId: number; username: string; body: string; status: string; createdAt: string; }
```

### Creators (follow + subscribe)
| Method | Path | Body | → |
| --- | --- | --- | --- |
| GET | `/api/creators/:id` | | `{ creator }` — counts, offer, viewer state |
| POST | `/api/creators/:id/follow` | | `{ following, followers }` |
| DELETE | `/api/creators/:id/follow` | | `{ following, followers }` |
| GET | `/api/creators/me/subscription` | | `{ subscription }` — own offer |
| PUT | `/api/creators/me/subscription` | `{ enabled, price, periodDays, perk }` | `{ subscription }` |
| POST | `/api/creators/:id/subscribe` | `{ phone? }` | 201 `{ subscription }` (free) or `{ charge }` (paid) |
| DELETE | `/api/creators/:id/subscribe` | | `{ subscription }` — stop renewing, access until expiry |

### Charges (the STK push)
| Method | Path | Body | → |
| --- | --- | --- | --- |
| POST | `/api/charges` | `{ purpose: 'post'\|'room'\|'sub', refId, phone }` | 201 `{ charge }` |
| GET | `/api/charges/:id` | | `{ charge }` (owner only — poll every 3 s) |

```ts
interface Charge {
  id: number; purpose: 'post' | 'room' | 'sub' | 'premium'; refId: number;
  amount: number; currency: string; commission: number; net: number;
  status: 'pending' | 'paid' | 'failed' | 'expired';
  phone: string; mpesaRef: string | null; checkoutRequestId: string | null;
  error: string | null; instructions: string | null;
  periodDays: number | null;  // `sub` only
  createdAt: string; paidAt: string | null;
}
```
Errors: `409 already-owned`, `400 invalid-phone`, `409 charge-pending` (reuse
the open charge), `502 stk-failed`, `409 payments-disabled`.
Charges expire after 5 minutes (STK push lifetime).

### Wallet
| Method | Path | Body | → |
| --- | --- | --- | --- |
| GET | `/api/wallet` | | `{ wallet, entries: WalletEntry[] }` |
| POST | `/api/wallet/withdraw` | `{ phone, amount }` | 201 `{ entry }` — reserves the balance, admin approves in `/admin` → Earnings |

```ts
interface Wallet { accountId: number; username: string; balance: number; lifetimeIn: number; lifetimeOut: number; updatedAt: string; }
interface WalletEntry { id: number; amount: number; kind: 'sale'|'adjustment'|'withdrawal'; status: 'posted'|'pending'|'approved'|'rejected'; memo: string | null; createdAt: string; }
```

### Rooms (group calls + conferences)
| Method | Path | → |
| --- | --- | --- |
| GET | `/api/rooms?kind=group\|conference&adult=0\|1` | `{ items: Room[] }` (live) |
| GET | `/api/rooms/:slug` | `{ room, entitled, canEnter }` |

```ts
interface Room {
  id: number; slug: string; title: string; kind: 'group' | 'conference';
  hostId: number; hostName: string;
  price: number; currency: string;
  isAdult: boolean; maxParticipants: number;
  status: 'live' | 'ended'; participants: number; createdAt: string;
}
```

**Socket events** (added to `protocol.js` and `lib/signaling.ts`):

| C→S | payload | S→C replies |
| --- | --- | --- |
| `room:create` | `{ title, price, isAdult, max, kind }` | `room:created { room }` |
| `room:enter` | `{ slug }` | `room:joined { room, self, peers: [{id, username, country}] }` |
| `room:signal` | `{ slug, to, kind, payload }` | `room:signal { from, kind, payload }` (relay) |
| `room:leave` | `{ slug }` | `room:state` broadcast |
| `room:end` | `{ slug }` | `room:closed { slug }` (host only) |

Broadcasts: `room:state { slug, participants: [{id, username, country}], count }`,
`room:closed { slug }`, plus the existing `server:error { code, message }`.

`room:enter` failure codes: `payment-required` (no paid charge — client opens
the pay sheet), `adult-only` (under 18 or adult content switched off),
`room-full`, `room-ended`, `unauthorized`, `groups-disabled`.
Mesh WebRTC: the side with the **higher** account id is the initiator for that
pair (deterministic, no glare); each client runs one `Peer` per remote id.

---

## 4. Admin API (all under `adminRoute()` + `adminLimiter`)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/admin/overview` | dashboard totals, calls, live queue, database footprint, media backend |
| GET | `/api/admin/db` | MariaDB version, exact data/index sizes, table estimates, connection headroom, pool and replica state |
| POST | `/api/admin/media/prune?dryRun=1` | object-storage/legacy-media lifecycle sweep; dry run reports without deleting |
| GET | `/api/admin/posts?status=&q=&page=&size=` | `{ items, total, page, size }` |
| PATCH | `/api/admin/posts/:id` | `{ status: 'active'\|'hidden'\|'removed' }` |
| GET | `/api/admin/charges?status=&page=&size=` | ledger of all new payments |
| PATCH | `/api/admin/charges/:id` | `{ status: 'paid'\|'failed', note? }` — approving settles the wallet (manual mode) |
| GET | `/api/admin/rooms?status=` | `{ items }` |
| PATCH | `/api/admin/rooms/:id` | `{ status: 'live'\|'ended' }` — ending a room closes it live |
| GET | `/api/admin/earnings` | `{ gross, commission, net, paid, pending, failed, byDay: [{day,count,gross,commission}], withdrawals: [{id,username,amount,phone,status,createdAt}] }` |
| GET | `/api/admin/wallets` | `{ items: Wallet[] }` |
| POST | `/api/admin/wallets/adjust` | `{ accountId, amount, memo }` → `{ wallet }` |
| PATCH | `/api/admin/wallet-entries/:id` | `{ status: 'approved'\|'rejected' }` — rejects refund the reservation |
| PUT | `/api/admin/settings` | accepts `payment?`, `features?`, `commerce?`, `mpesa?` |

Admin wire types live in `client/src/admin/api.ts`; audit every mutation with
`admin.audit(identity, action, target, detail)` (`post.hide`, `charge.approve`,
`room.end`, `wallet.adjust`, `payout.approve`, …).

---

## 5. Client structure

No router library. `client/src/lib/router.ts` is a ~60-line pathname router
(`useRoute()`, `navigate()`, `<Link>`); `main.tsx` picks `/admin` → `AdminApp`,
everything else → `Shell`.

| Route | Page | Notes |
| --- | --- | --- |
| `/` | FeedPage | paid + free posts, adult filter switch |
| `/explore` | ExplorePage | search, creators, top posts |
| `/create` | CreatePostPage | upload/link, **price + fee preview**, 18+ flag |
| `/post/:id` | PostDetailPage | paywall → PaySheet → unlocked media + comments |
| `/creator/:id` | CreatorPage | follow, free/paid subscribe, creator posts |
| `/live` | LivePage | 1v1 Match card, group calls,18+ conferences |
| `/room/:slug` | RoomPage | paid entry + mesh group call UI |
| `/match` | MatchPage | the **existing** `App.tsx` untouched, full-bleed |
| `/wallet` | WalletPage | balance, earnings split, transactions, withdraw |
| `/profile` | ProfilePage | own posts, creator stats, subscription offer settings |
| `/settings` | SettingsPage | account, adult acknowledgement, sign out |

`Shell` owns the signed-in `account`, `config` and the nav (top bar + bottom
tab bar on mobile); `/match` and `/room/:slug` render full-bleed without the
tab bar. Shared: `components/AuthDialog.tsx` (sign in/up used by every page),
`components/PaySheet.tsx` (phone → Pay → STK prompt → poll → `onPaid`).

Conventions to keep: error envelopes `{error:{code,message}}` shown verbatim;
`SIGNALING_URL` base; Tailwind v4 tokens + `.btn/.card/.field/.label`; no
contexts — props from `Shell`; module-level fetch caches in `lib/*`.
