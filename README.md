# Matchup — 1v1 global video chat + a creator platform

A production-ready 1v1 video chat app — wrapped in a social platform where
creators post content, charge for it in KES and get paid over M-PESA. Two
strangers are matched by preference and exchange media through Matchup's own
app-server relay. There is **no STUN, TURN, WebRTC or peer-to-peer dependency**:
the browser encodes camera/mic slices and sends them over the same authenticated
HTTP channel as signaling, and the server forwards them to the partner.

```
  Browser A  ──HTTP long-poll──▶  Matchup server (Node + Express)  ◀──HTTP long-poll──  Browser B
      │                         matchmaking + signaling + media relay                         │
      └──────────────────── encoded media slices (no STUN/TURN/NAT) ───────────────────────┘
```

| Layer      | Tech                                                          |
| ---------- | ------------------------------------------------------------- |
| Frontend   | React 19 + Vite + TypeScript + Tailwind CSS v4                 |
| Signaling  | Node.js + Express 5 + HTTP long-poll                           |
| Database   | MariaDB → MongoDB → in-memory (first one configured wins)      |
| Media      | MediaRecorder → app-server HTTP relay (no STUN/TURN)           |
| Deployment | **One container** — app + API + admin on Koyeb/Render/VPS ([DEPLOY.md](DEPLOY.md)) |

**Verified end-to-end**: 44/44 browser E2E checks (match → relay → both-way video →
mute/camera → chat → Spark → rock-paper-scissors duel → hang-up → *Next* →
re-match → share card → live country board → the Passport → accounts →
telemetry), 28/28 account checks, 40/40 platform checks (commission split,
M-PESA charges, wallets, payouts), 26/26 dashboard checks, 16/16 signaling
checks, plus a live relay-transport check. See [Testing](#7-testing).

**Accounts**: create a username + password once (scrypt-hashed in MariaDB), stay
signed in on that device, come back later with everything prefilled — and change
*any* profile field or preference whenever you like.

**The Passport**: every connected call stamps the partner's country into a
personal collection book — flags, counts, day-streaks and six achievements,
teased live *while you queue*. Anonymous visitors collect on the device;
signing up syncs the book across devices forever.

**The social platform** (`docs/PLATFORM.md` is the full contract): a feed of
photo/video posts — free or priced per view, in KES — plus Explore, a creator
wallet with a configurable platform commission (default 15%), payout requests,
paid group calls and 18+ conferences. Payments run on **M-PESA**: the buyer
types their phone number, presses Pay and gets a Daraja STK PIN prompt; the
charge row is both the receipt and the unlock, and the money lands in the
creator's wallet already split (net to the creator, commission to the house).
The callback settles every charge the moment the PIN lands, so nothing waits
on an approval — until Safaricom credentials are entered in **/admin →
Settings**, pay buttons say so plainly rather than prompting. `/admin` also
owns commerce switches, commission rate, price caps, room moderation, the
earnings ledger and payouts. The original 1v1 video app lives at `/match` —
the emphasised centre tab.

**Guides**: [DEPLOY.md](DEPLOY.md) — run the whole app independently on free
tiers (no card, no GitHub) · [ADS.md](ADS.md) — show ads *and* run promotion
campaigns.

---

## 1. Project structure

```
matchup/
├── client/                          # Vite + React + TS (deployed to Vercel)
│   ├── index.html
│   ├── vite.config.ts               # dev proxy for /api + /socket.io
│   ├── vercel.json                  # SPA rewrite + asset caching headers
│   ├── tsconfig.json
│   └── src/
│       ├── main.tsx                  # mounts the Shell (or /admin) for every path
│       ├── App.tsx                   # 4-phase machine: lobby → waiting → chat → post-call
│       ├── types.ts                  # shared domain types + signaling contract
│       ├── types/social.ts           # posts, charges, wallets, rooms
│       ├── index.css                 # Tailwind v4 theme + component classes
│       ├── shell/                    # the social app: nav, routing, page props
│       ├── pages/                    # Feed, Explore, CreatePost, PostDetail, Live,
│       │                             # Room (mesh group call), Wallet, Profile,
│       │                             # Settings, Match (the original 1v1 app)
│       ├── admin/                    # the /admin dashboard (tabs + API client)
│       ├── components/
│       │   ├── LobbyForm.tsx         # profile + preferences + account panel
│       │   ├── WaitingScreen.tsx     # "Waiting…" + live presence counters
│       │   ├── VideoChat.tsx         # call screen, controls, state HUD
│       │   ├── PostCall.tsx          # after a call: Next / Stop matching / share card
│       │   ├── EuropeBoard.tsx       # live online-by-country panel ("#europe")
│       │   ├── AuthDialog.tsx        # sign in / up, used by every gated page
│       │   ├── PaySheet.tsx          # M-PESA: phone → Pay → STK PIN prompt
│       │   └── icons.tsx             # inline SVG icons (no icon dependency)
│       ├── hooks/                    # (reserved)
│       └── lib/
│           ├── signaling.ts          # typed HTTP long-poll client + event contract
│           ├── rooms.ts              # room signaling client (group calls)
│           ├── peer.ts               # media transport (app-server relay)
│           ├── iceServers.ts         # media transport config (relay mode)
│           ├── auth.ts               # /api/auth client + bearer token in localStorage
│           ├── social.ts             # /api/posts, /api/wallet, /api/rooms client
│           ├── router.tsx            # pathname router (no dependency)
│           ├── config.ts             # /api/config typed + defaults
│           ├── draft.ts              # device-local "remember my form" fallback
│           ├── api.ts                # GET /api/presence (the live board's data)
│           ├── geo.ts                # country centroids → distance + Europe set
│           ├── postcard.ts           # shareable "connection card" (canvas + share)
│           ├── media.ts              # getUserMedia + error mapping
│           └── countries.ts          # locale-aware country list
│
├── server/                          # Signaling server (deployed to Render)
│   ├── server.js                    # Express + HTTP signaling + media relay + auth
│   ├── render.yaml                  # Render blueprint (infra as code)
│   ├── .env.example
│   └── src/
│       ├── protocol.js              # event names + payload docs (mirrors client)
│       ├── matchmaking.js            # validation + symmetric match rule
│       ├── matchmaker.js             # FIFO queue, rooms, signal relay, presence
│       ├── accounts.js               # register/login/sessions (scrypt, bearer tokens)
│       ├── payments.js               # premium — opens the charge, fires the STK push (or manual pending approval)
│       ├── commerce.js               # posts, paywall, charges, commission split, wallets, rooms
│       ├── socialStore.js            # social tables (posts, charges, wallets, rooms…)
│       ├── mpesa.js                  # Daraja STK push + callback parsing
│       ├── rooms.js                  # RoomHub — mesh signaling for group calls
│       ├── settings.js               # payment/features/commerce/mpesa config + sanitizers
│       ├── admin.js                  # every dashboard operation + audit trail
│       ├── iceConfig.js              # relay config served to browsers
│       ├── telemetry.js              # per-call outcome aggregation (/api/stats)
│       ├── mariaStore.js             # local MariaDB backend (profiles, accounts, social tables)
│       └── store.js                  # MariaDB → MongoDB → in-memory facade
│
├── scripts/                         # operations + verification
│   ├── mariadb-init.sql             # one-time: create the database + app user
│   ├── local.sh                     # start / stop / status the local signaling server
│   ├── test-signaling.js            # 16 checks against the live server
│   ├── test-db.js                   # is the app really linked to the database?
│   ├── test-auth.js                 # 28 checks: the whole account lifecycle
│   ├── test-admin.js                # 26 checks: the dashboard (login, ledger, bans)
│   ├── test-platform.js             # 40 checks: posts, M-PESA charges, commission, wallets
│   ├── test-ui.js                   # 15 checks: the social shell renders, tabs resolve
│   ├── e2e.js                       # 44 checks: Chromium + media relay
│   └── package.json                 # e2e needs puppeteer-core only
│
├── docs/
│   └── PLATFORM.md                  # the social platform's full contract (API, DB, routes)
│
└── README.md
```

---

## 2. Quick start (local)

Prerequisites: **Node ≥ 20**, npm, a Chromium/Firefox browser, a camera.

```bash
# 1. Install
cd client && npm install
cd ../server && npm install

# 2. Configure (optional — everything has a local default)
cp server/.env.example server/.env
cp client/.env.example client/.env.local

# 3. Run both (two terminals)
cd server && npm run dev          # http://localhost:4000
cd client && npm run dev          # http://localhost:5173  (proxies to :4000)

# …or from the repo root:
npm run dev

# 4. Optional: fill the feed with demo content — 10 photo posts from 4
#    creators (free + priced), likes and comments, all through the real API.
#    Re-running is safe: seeded creators are skipped, stale test rows swept.
npm run seed
```

Open **two tabs** on `http://localhost:5173`, fill in two complementary profiles
(e.g. *female, 24, wants men* / *male, 27, wants women*) and start matching.

> Camera access requires a secure context: `http://localhost` works out of the
> box; any other host must be served over **HTTPS**.

---

## 3. Environment variables

### `server/.env`

| Variable             | Required | Purpose                                                            |
| -------------------- | -------- | ------------------------------------------------------------------ |
| `PORT`               | no       | Injected by Render/Railway; defaults to `4000`                     |
| `CORS_ORIGIN`        | yes (prod) | Comma-separated allowed origins — your Vercel URL                |
| `MARIADB_HOST` / `MARIADB_PORT` | no | Defaults `127.0.0.1:3306` (the local server)               |
| `MARIADB_USER` / `MARIADB_PASSWORD` | for local DB | App user from `scripts/mariadb-init.sql`          |
| `MARIADB_DATABASE`   | for local DB | Set it ⇒ MariaDB is used ([details](#55-keeping-the-database-on-this-pc-mariadb)) |
| `MONGODB_URI`        | alt      | MongoDB instead (used only when `MARIADB_DATABASE` is empty)       |
| `PRESENCE_INTERVAL_MS` | no     | Live counter push interval (default `5000`)                        |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | no | Creates the first `/admin` dashboard login on the very first boot (10+ chars). Ignored afterwards — the dashboard owns its credentials |
| `BLOB_READ_WRITE_TOKEN` | production | Vercel Blob token. When set, new uploads go to a private Blob store and the browser uploads directly (no function body limit); unset falls back to `media_blobs` in MariaDB. |
| `MEDIA_TOKEN_SECRET` | no       | Key for the signed `?t=` claims on paid media URLs. Unset ⇒ a random per-boot key (fine for one instance; set it if you scale past one so links survive restarts/instances) |
| `MEDIA_TOKEN_TTL_MS` | no       | How long a paid-media claim stays valid (default `3600000` = 1h)     |
| `MARIADB_POOL_SIZE` | no | Connections per serverless instance (default `5`; keep `pool × warm instances` below `max_connections`) |
| `MARIADB_STORAGE_LIMIT_MB` | no | Disk budget shown in `/admin` → Database (default `1024`; display-only, raise it when the plan changes) |
| `MARIADB_QUEUE_LIMIT` | no | Queries allowed to wait for a pooled connection (default `0` = unbounded queue) |
| `MARIADB_IDLE_TIMEOUT_MS` / `MARIADB_MAX_IDLE` | no | Pool idle eviction (defaults `30000` / `10000`) |
| `MARIADB_READ_HOST` / `MARIADB_READ_PORT` | no | Optional read replica. When set, public feeds and anonymous creator cards use it; auth, money, entitlement and signed-in viewer state stay on the primary. Falls back automatically if the replica is down. |
| `MARIADB_READ_USER` / `MARIADB_READ_PASSWORD` / `MARIADB_READ_SSL` | no | Optional replica credentials/TLS overrides (defaults to the primary values) |
| `MARIADB_READ_POOL_SIZE` | no | Replica pool size per instance (default `5`) |
| `MEDIA_ORPHAN_GRACE_HOURS` | no | Blob objects without a post are kept this long before cleanup (default `24`) |
| `MEDIA_RETENTION_DAYS` | no | Legacy unreferenced `media_blobs` rows are removed after this age (default `30`) |
| `MEDIA_CACHE_MAX_AGE_SEC` | no | Blob cache lifetime for immutable media keys (default `31536000` = 1 year) |
| `CRON_SECRET` | production | Authorizes the daily `/api/cron/media` lifecycle sweep. Vercel Cron sends it as `Authorization: Bearer …`. |

### `client/.env.local`

| Variable           | Purpose                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `VITE_SIGNALING_URL` | Absolute URL of the signaling server. **Empty ⇒ same origin** (dev proxy) |
| `VITE_ICE_URL`     | Diagnostic only; relay mode ignores it and `/api/ice` returns an empty list |

---

## 4. How it works

### 4.1 Matchmaking (server)

`server/src/matchmaker.js` keeps one FIFO queue. When a user joins:

1. The profile is validated (`matchmaking.js`): age 18–99, ISO country code,
   username sanitized of control/zero-width characters, age range clamped so it
   always includes the user's own age (a range that excludes yourself could never
   match — the rule is symmetric).
2. The queue is scanned **in arrival order** and the first entry that *both* sides
   accept is paired ("first available user", not random).
3. Match rule (symmetric — both must accept):
   * **Gender**: `preferredGenders` contains `'any'` or the other person's gender.
   * **Age**: each person's age falls inside the other's `ageMin…ageMax`.
4. If nothing matches, the user is queued and receives `match:waiting` with live
   `looking` / `online` counters (pushed every few seconds while queued).

A room id is generated and **one side is flagged `initiator: true`**. The relay
does not need an offer/answer handshake; the flag is retained for compatibility
with the optional WebRTC path.

### 4.2 Signaling contract

Defined once in `client/src/lib/signaling.ts`, mirrored in `server/src/protocol.js`:

| Direction | Event            | Payload                                   |
| --------- | ---------------- | ----------------------------------------- |
| C → S     | `queue:join`     | `{ profile }`                             |
| C → S     | `queue:leave`    | —                                         |
| C → S     | `signal:data`    | `{ roomId, kind: offer\|answer\|candidate\|media, payload }` |
| C → S     | `call:end`       | —                                         |
| S → C     | `match:found`    | `{ roomId, peer, initiator }`             |
| S → C     | `match:waiting`  | `{ looking, online }`                     |
| S → C     | `signal:data`    | same as C → S (relayed to the partner)    |
| S → C     | `peer:left`      | `{ roomId, reason: ended\|disconnected }` |
| S → C     | `presence`       | `{ looking, online }`                     |
| S → C     | `server:error`   | `{ code, message }`                       |

The relay only forwards messages whose `roomId` matches the sender's room, is rate
limited (80 msgs/s/session) and media slices are capped at 90 KB of base64.

### 4.3 Media transport (`client/src/lib/peer.ts`)

The default and only configured transport is the app-server relay:

* **No handshake** — both sides start a `MediaRecorder` as soon as the match is
  created and send slices over the signaling channel; there is no SDP/ICE
  exchange and no NAT traversal.
* **Format fallback** — the recorder picks the first supported format from WebM
  VP8/VP9 and MP4 H.264; the receiver creates the matching `MediaSource`.
* **Watchdog** — if no remote slice arrives within 20 s, the call fails cleanly
  with **"Unable to connect"** and *Try again* / *Find someone else*.
* **Path readout** — `getStats()` shows `Server relay` in the call header, so
  the UI is explicit about the transport in use.

The file also keeps a `WebRtcPeer` implementation for a future direct/LAN mode,
but `getIceConfig()` returns `iceServers: []`, so `Peer` always selects the
relay. No STUN or TURN URL is configured anywhere.

Connection states → UI: `connecting` · `connected` · `reconnecting` · `failed`.

### 4.4 Media connectivity (app-server relay)

```
MediaRecorder → ~800 ms encoded slices → POST /api/rt/emit → partner inbox
              → partner appends to MediaSource → <video> plays the stream
```

* The browser captures camera/mic and records small WebM (or MP4) slices.
  Each slice is base64-encoded and sent as a `signal:data` message with
  `kind: "media"`; the server validates size/rate and forwards it to the
  partner. The partner appends slices to a `MediaSource` and exposes the
  resulting `<video>` as a `MediaStream`, so the call UI is unchanged.
* There is **no ICE, no STUN, no TURN and no UDP requirement**. This works on
  CGNAT, strict corporate firewalls and mobile carriers because it rides the
  same HTTPS/long-poll channel as chat and signaling.
* `GET /api/ice` returns `{ iceServers: [], source: "relay" }`.
  `GET /health` → `ice: { source: "relay", transport: "http-long-poll" }`.
* The trade-off is latency (roughly 1–3 seconds) and server bandwidth. This is
  a relay, not a low-latency SFU; size the deployment for the media volume you
  expect.
* If the relay cannot start, the call fails cleanly with **"Unable to
  connect"**. Chat still works because it uses the same signaling channel.

**Call telemetry.** Every call sends one `call:report` (selected media transport,
RTT when available, duration). They aggregate in `GET /api/stats` → `calls`:

```jsonc
{
  "outcomes": { "connected": 42, "failed": 3, "successRate": 93.3 },
  "paths":    { "host": 0, "srflx": 0, "prflx": 0, "relay": 42, "unknown": 3 },
  "iceSources": { "relay": 42, "unknown": 3 },
  "rttMs": { "samples": 42, "avg": 47 }
}
```

`outcomes.failed` is the number that matters: every one of those is a user who
saw "Unable to connect". `paths.relay` shows calls that used the app relay;
`host`/`srflx` remain in the schema for historical rows.

### 4.5 Accounts, sessions and the post-call flow

**Accounts** (`server/src/accounts.js` + `client/src/lib/auth.ts`) — optional but
persistent: create one from the lobby, stay signed in on that device, come back
with everything prefilled.

| Route | Body | Returns |
| --- | --- | --- |
| `POST /api/auth/register` | `{ username, password, profile }` | `201 { token, user }` |
| `POST /api/auth/login` | `{ username, password }` | `200 { token, user }` |
| `GET /api/auth/me` | `Authorization: Bearer` | `200 { user }` |
| `PUT /api/auth/profile` | `Bearer` + `{ profile }` | `200 { user }` |
| `POST /api/auth/logout` | `Bearer` | `204` |

* **Hashing**: scrypt (N=16384, r=8, p=1) with a 16-byte random salt — built on
  `node:crypto`, no dependency. Login runs the same computation against a dummy
  hash when no user matches, so "no such user" and "wrong password" take the same
  time.
* **Sessions**: a 32-byte random bearer token in `localStorage`; only its SHA-256
  lives in `account_sessions`, so a leaked row cannot be replayed. 30-day TTL,
  swept on the same timer as profile TTLs.
* **Everything is editable**: username, age, gender, country, preferred genders
  and the age range — `PUT /profile` validates through the same `validateProfile`
  the queue uses, and a rename goes through the unique index (409 on collision).
* **Profile photos**: an avatar and a background photo per account, uploaded in
  **Settings** (`POST /api/me/photo`, raw bytes, JPEG/PNG/WebP/GIF ≤ 4 MB).
  Other people see them on your profile, your public creator page, your posts,
  your comments and the nav chip; a missing photo falls back to your first
  letter. Stored in the same private Blob/DB ladder as post media (`avatar_key` /
  `banner_key` on the account) — never a public bucket, and the daily sweep
  keeps anything an account still references.
* **Backends**: MariaDB (`accounts`/`account_sessions`, created idempotently on
  boot) when the store is up, an in-process Map otherwise. `GET /health` reports
  `accounts: maria | memory`.
* **Rate limits**: 20 credential attempts/min/IP (scrypt is CPU), 120 authenticated
  calls/min/IP → `429` with a readable message.

**Post-call flow.** A call never re-queues itself. Both sides land on
`PostCall.tsx` — *you hung up* shows "Call ended", *they left* shows "Stranger
disconnected" — and pick:

* **Next** → `call:end` (no-op if the room is already closed) + `queue:join`
  straight back into the queue, or
* **Stop matching** → `queue:leave`, camera released, back to the lobby with the
  profile prefilled (account first, then the device-local draft).

The lobby's *Start matching* persists the current form to the account as it
queues, so preferences are never lost between visits.

**Reach surfaces.** Two aggregate-only surfaces help a specific place without
ever restricting *who* matches with whom (anyone can pair with anyone):

* `GET /api/presence` → `{ online, looking, located, byCountry: [{code, online}] }`
  — live counts per country, computed in memory from the profile each socket
  submitted on `queue:join`. Only sums leave the process: no name, IP, session
  or timestamp. Rate-limited to 60/min/IP, `Cache-Control: no-store`.
* **The board** (`EuropeBoard.tsx`, lobby button or `#europe`) renders those
  counts split into *In Europe* / *Elsewhere* — honest social proof ("is anyone
  awake near me?") for a visitor deciding whether to press Start.
* **The card** (`lib/postcard.ts`) — after a call that actually connected, the
  post-call screen offers *Share this connection*: a story-format image with two
  flags, the great-circle distance (`lib/geo.ts`), how long you talked and the
  URL. Rendered in the browser's canvas, handed to the native share sheet, shown
  back on screen, with clipboard → visible-text fallbacks. Country codes and
  duration only — never a name, age or face — and nothing is rendered unless the
  button is pressed.

### 4.6 The Passport (collection + retention)

The layer that gives people a reason for *one more match*:

* **Stamping** — when a call that actually connected ends, `captureShare()`
  stamps the partner's country (`lib/passport.ts` → `addStamp`). First time =
  "🌍 NEW STAMP!" celebration on the post-call screen with the running total
  and streak.
* **Storage** — localStorage is the source of truth (works signed-out and
  offline). Signed-in accounts also merge with `POST /api/passport/sync`
  (per-country **max**, so replays never inflate counts) into
  `passport_stamps` / `passport_meta`. Passport rows are **never age-purged**
  and cascade with the account — a collection that evaporates kills the reason
  to return. Days are UTC so every device agrees on the streak.
* **Surfaces** — lobby button *My passport · N* → the book (`#passport`,
  every flag dimmed until stamped, six achievements); the waiting screen's
  **Collect while you wait** strip polls `/api/presence` and shows countries
  online *right now* that you're missing (queue time becomes anticipation);
  the share card grows a "🌍 N countries in my passport" line, turning every
  share into a recruitment pitch for the collector.
* **Conversion** — anonymous visitors collect on the device; the lobby nudge
  and the book itself push "create an account to keep your stamps forever",
  and `syncPassport()` runs on every sign-in/register so the merge is
  automatic.

### 4.7 The in-call playground

The moment both people are looking at each other used to be three buttons and
silence. The call screen is now a navigable playground where every control is
a labelled dock button (plus shortcuts **M/V/C/S/D/R/F/H**, **Esc** closes the
top panel, **H** gives an immersive chrome-free view with one tap back):

* **💬 Chat** — a side drawer that works even if someone's camera is blocked
  or they're camera-shy; unread badge, Enter to send.
* **✨ Spark** — a shared conversation-starter card (`lib/callDeck.ts`, ~50
  prompts). Either side draws, **both** screens show the same card — dead air
  is the number-one reason people quit a random chat early.
* **✊ Duel** — rock-paper-scissors, first to 2, picks locked until both are
  thrown and revealed with the same "✊ beats ✌️" line on both screens.
* **😊 Reactions** — floating emojis that rise over either video.
* **🧬 Chemistry** — a live meter in the header that starts at 50% and rises
  only with real interaction (chat, sparks, duel rounds, reactions). Both
  screens compute the **identical** number because it's a pure function of
  the room's event counts — own sends plus partner relays are the full
  history. The post-call screen shows it when it went above 50.
* **⏱ Milestones** — the call timer celebrates 1/3/5/10 minutes together:
  the patience beat that keeps people from skipping a good conversation.

Transport: a `call:event` relay channel next to `signal:data`
(`protocol.js` → `matchmaker.relayCallEvent`) with a server-side **whitelist**
(chat/react/spark/duel payloads rebuilt field-by-field, 500-char chat cap,
fixed emoji set), spoofed-room drops, and its own 15/s rate limit so the fun
channel can never crowd out the media/signaling relay. No server game state: everything
shared is derivable from the same events both sides already see.

### 4.8 Admin dashboard & M-PESA payments

Two features that live entirely behind the same process — no extra service:

**`/admin`** — a login-protected dashboard (`server/src/admin.js` +
`client/src/admin/`): live users and queue, call telemetry, the payments
ledger, feature switches (ads / sign-ups / payments / **maintenance**), ban &
premium controls, a full per-account **Inspect** view (every post — paid and
18+ included — comments, follows, subscriptions, charges, wallet, sessions
and rooms, with the media itself streamed to the owner past the paywall and
audited whenever it is paid or adult), room rosters and an audit trail of
every action. Admins live in their own
`admins` table with their own scrypt hashes and 12-hour sessions — being a
user of the app can never make you an admin of it.

**M-PESA payments** (`server/src/payments.js` + `client/src/lib/payments.ts`)
— a visitor signs in, enters their M-PESA number and presses Pay. Daraja
pushes a PIN prompt to their phone; Safaricom's callback settles the charge,
and premium (or the post, or the room) opens without anyone approving
anything. A lost callback is covered by polling Daraja directly. Everything
(price, premium length, wording, Daraja credentials) is edited in `/admin` →
Settings and applies live, and **Test connection** there reports exactly which
credential is still missing. **No Daraja?** Settings also has a **Manual
payments** mode: buyers see where to send the money (e.g. Pochi la Biashara)
and every charge lands pending in `/admin` → Earnings; approving it there
takes the platform cut, credits the creator's wallet and unlocks whatever was
bought — exactly like an STK sale. Full guide, including what to ask
Safaricom for and the manual steps: [docs/PAYMENTS.md](docs/PAYMENTS.md).

Payouts are weekly: every creator is paid out once a week, on the day you set
in `Settings → Creator payouts` (default Friday). A creator requests in
`/wallet` any time, it lands in `Earnings → Payout requests`, and you send the
money by M-PESA (Pochi) once a week and approve each request.

Paid content access is timed, never permanent: creators choose the window
(15 minutes to 24 hours) when they publish, and a purchase grants exactly
that window — buy again to extend it. Nothing is "forever" unless it predates
the feature.

Matchmaking enforces all of it: a banned account cannot log in *or* queue
(username and IP), a `features.maintenance` flip pauses the queue instantly,
and `GET /api/config` hands the switches to the lobby.

---

## 5. Deployment

> **Run it fully independently → [DEPLOY.md](DEPLOY.md)** — one container (app +
> API + media relay + `/admin`) on free Koyeb and free Aiven MySQL. No credit
> card, no GitHub, no separate frontend host, and your PC can be switched off.
> The sections below cover the classic paths (Render blueprint, local MariaDB).
>
> **Payments → [docs/PAYMENTS.md](docs/PAYMENTS.md)** — accepting money by
> M-PESA STK push, and what to ask Safaricom for so the cash lands on your
> own number.
>
> **Ads & promotion → [ADS.md](ADS.md)** — AdSense/ad-network setup in the app
> plus the paid-campaign playbook.

### 5.1 Backend → Render (or Railway)

1. Push the repo to GitHub.
2. Render → **New → Blueprint** → select the repo. `server/render.yaml` is picked
   up automatically (`rootDir: server`, `start: npm start`, `health: /health`).
   *Railway*: New Project → Deploy from GitHub → set **Root Directory** `server`,
   start command `npm start`.
3. Environment variables (Dashboard → Environment):
   * `CORS_ORIGIN=https://your-app.vercel.app`
   * `MONGODB_URI=…` (optional, e.g. MongoDB Atlas free tier)
4. Copy the service URL, e.g. `https://matchup-signaling.onrender.com`.
5. Smoke-test: `curl https://…/health` → `{"status":"ok",…}`.

> Render/Railway terminate TLS and proxy long-poll HTTP out of the box — the
> relay needs no extra configuration on a single instance.

### 5.2 Frontend → Vercel

> **Storing data on your own PC?** Then the signaling server runs here too
> instead of Render — follow [§5.5](#55-keeping-the-database-on-this-pc-mariadb)
> and come back only for steps 1–4 below, with `VITE_SIGNALING_URL` set to your
> API's **permanent public https URL**. The Cloudflare quick tunnel this guide
> used to wire up has been removed: it mints a new address on every restart, so
> a client built against it eventually points at a dead host.

1. Vercel → **Add New → Project** → import the repo.
2. Set **Root Directory** to `client` (Settings → General), framework preset
   *Vite* (auto-detected), build `npm run build`, output `dist`.
3. Environment variable: `VITE_SIGNALING_URL=https://matchup-signaling.onrender.com`.
4. Deploy. `client/vercel.json` already handles the SPA rewrite and long-lived
   asset caching.
5. Back in Render, set `CORS_ORIGIN` to the final Vercel URL (comma-separate
   multiple preview URLs) — otherwise the browser's API calls are rejected by CORS.

**Order matters**: deploy the backend first, then the frontend, then update
`CORS_ORIGIN`. Redeploying the frontend after that picks up the env var.

**No GitHub repo?** Deploy straight from this machine — the Vercel CLI needs no
repository:

```bash
cd ~/Desktop/matchup/client
npx vercel login                                  # once per machine (browser opens)
npx vercel link --yes --project matchup           # create + link the project
npx vercel env add VITE_SIGNALING_URL production   # paste your API's public https URL
npx vercel --prod                                 # first deploy (builds with the URL)
```

`VITE_*` values are baked in **at build time**, so the env var must exist before
the deploy that should use it. Then copy the printed
`Production: https://….vercel.app` into `CORS_ORIGIN` in `server/.env` and
restart the server — with `CORS_ORIGIN=*` the app still works, but pinning the
exact origin is what you want in production.

### 5.3 Standalone (single container, single URL) — the default

The root `Dockerfile` builds the client **inside** the image and copies the
bundle next to the server, so one process serves the app, the API, the media
relay and `/admin` from one origin:

```bash
docker build -t matchup .          # ~1 min warm, ~2 cold
docker run -p 4000:4000 --env-file prod.env matchup
open http://localhost:4000        # the whole app
```

`VITE_SIGNALING_URL` is left empty on purpose: the bundle calls `/api` and
`/api/ice` on its own origin. Deploy the same image with
`./scripts/deploy.sh` — [DEPLOY.md](DEPLOY.md) walks through Koyeb end to end.
If you'd rather build the client on the host (`cd client && npm run build`),
the server still auto-detects `client/dist` and serves the SPA exactly as before.

### 5.4 Network connectivity (app-server relay)

Matchup does **not** run or require STUN or TURN. Media is relayed by the app:

* `server/src/iceConfig.js` serves an empty ICE list from `GET /api/ice`
  (`source: "relay"`); no STUN/TURN URL is configured or read.
* The browser records camera/mic slices and sends them over the same HTTP
  long-poll channel as signaling. No UDP ports, public IPs or NAT traversal are
  needed.
* No `TURN_*`, `CF_TURN_*`, `STUN_*` or `TWILIO_*` variables are needed.
* If the relay cannot start, the UI explains the problem and offers **Try
  again** / **Find someone else**. Chat events still travel over the signaling
  channel, independent of media.
* `GET /health` reports `ice.source: "relay"`.

No firewall rule, UDP port, container, systemd unit or hosted relay account is
part of this deployment.

### 5.5 Keeping the database on this PC (MariaDB)

This is the setup where **your data never leaves this machine**: MariaDB stores
everything under `/var/lib/mysql` and grows with the app, while the frontend is
still shipped to Vercel.

**Why the signaling server also has to run here:** Vercel serves static files
and short-lived functions cannot hold the MariaDB connection, and a database
on this machine is only reachable from this network. So:

```
browser ──▶ Vercel (static client)
                 │  VITE_SIGNALING_URL
                 ▼
        free tunnel (cloudflared / ngrok)   ← public HTTPS, outbound only
                 │
                 ▼
        this PC, localhost:4000  (Express + HTTP relay)
                 │
                 ▼
        MariaDB 127.0.0.1:3306  →  /var/lib/mysql   ← your data, your disk
```

**1. Start MariaDB** (already installed on this machine — `mariadb 11.8.8`;
on a fresh Debian/Ubuntu/Kali box install it first):

```bash
sudo apt-get install -y mariadb-server   # if mariadb --version says "not found"
sudo systemctl enable --now mariadb      # start now + on every boot
systemctl is-active mariadb              # → active
```

**2. Create the database and its user** (one paste — generates a random
password, runs `scripts/mariadb-init.sql`, and writes the credentials into
`server/.env`, which is git-ignored, so no secret ends up in the repo):

```bash
cd ~/Desktop/matchup
PW="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | cut -c1-24)"
sed "s/CHANGE_ME_PASSWORD/$PW/" scripts/mariadb-init.sql | sudo mariadb
printf 'MARIADB_HOST=127.0.0.1\nMARIADB_PORT=3306\nMARIADB_USER=matchup\nMARIADB_PASSWORD=%s\nMARIADB_DATABASE=matchup\n' "$PW" >> server/.env
echo "database created, credentials written to server/.env"
```

That creates the `matchup` database (utf8mb4, so flag emoji work) and a
least-privilege `matchup` user that can touch nothing else. Prefer to do it by
hand? Edit `CHANGE_ME_PASSWORD` in `scripts/mariadb-init.sql`, run
`sudo mariadb < scripts/mariadb-init.sql`, then add the five `MARIADB_*` lines
to `server/.env` yourself.

**3. Link and verify:**

```bash
npm run test:db     # connected? correct schema? utf8mb4? writable?
```

Expected ending: `Database linked: the app will persist profiles on this machine.`
Then start the app (`cd server && npm start`) — this log line

```
[store] connected to MariaDB 11.8.8-MariaDB-1 from Debian on 127.0.0.1:3306 (db=matchup, charset=utf8mb4/…)
```

and `"store":"maria"` in `curl -s localhost:4000/api/stats` confirm it. The app
creates its schema itself on first boot — there is nothing else to migrate.

**4. Reach it from the Vercel frontend.** The server needs a public HTTPS URL —
without one the deployed client has no API (it loads, quietly retries, and
nothing that needs data works). Two ways to get one:

```bash
# Recommended — a permanent address that never rotates:
#   Koyeb (image is on Docker Hub as mauru2df/matchup-server) or Render.

# Short-lived test only — a quick tunnel, run by hand when you need one:
cloudflared tunnel --url http://localhost:4000     # prints an https://…trycloudflare.com URL
```

* A quick tunnel gets a **new URL on every start**. Nothing in this repo
  pushes it to Vercel any more (the tunnel unit, the sync and the watchdog were
  removed for exactly that reason), so a client built against one will go stale
  the next time it restarts — which is why a permanent host is the answer for
  anything visitors are meant to reach.
* Set `VITE_SIGNALING_URL=<that URL>` in Vercel (Settings → Environment
  Variables) and redeploy the client — `VITE_*` values are baked in at build
  time, so the var must exist *before* the build.
* Set `CORS_ORIGIN=https://your-app.vercel.app` in `server/.env`, then restart
  the server — otherwise CORS rejects the browser.

**5. Keep it running.** MariaDB starts at boot (`systemctl enable` above). For
the app server, add a **user** service. It deliberately *waits for MariaDB*:
a user unit cannot order itself against a system unit, and without the wait the
server can boot first and silently fall back to the in-memory store.

```ini
# ~/.config/systemd/user/matchup.service
[Unit]
Description=Matchup signaling + media relay (1v1 video chat)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/Desktop/matchup/server
ExecStartPre=/bin/sh -c 'for i in $(seq 1 60); do systemctl is-active --quiet mariadb && exit 0; sleep 1; done; echo "MariaDB still not active after 60s" >&2; exit 1'
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now matchup
loginctl enable-linger $USER          # boot-time start, not just at login
```

**6. One command for everything.** The running stack is two units (the tunnel
and its watchdog are gone — see §5.2):

| Unit | Enabled? | Why |
| --- | --- | --- |
| `mariadb` (system) | ✅ | owns your data |
| `matchup` (user) | ✅ | waits for MariaDB, then serves API + signaling |

`scripts/local.sh` starts, repairs and reports the local stack:

```bash
scripts/local.sh status                 # units + health (reports the public API status too)
scripts/local.sh start                  # start/repair the signaling server
scripts/local.sh stop                   # stops the server (MariaDB keeps running)
```

**Operational notes**

| | |
| --- | --- |
| **Downtime** | The app is up while *this PC* is up. Vercel stays reachable regardless, but data and matching need this server **and** a public API URL (`VITE_SIGNALING_URL`) pointing at it. |
| **Backups** | The DB is now a file on your disk — cron `mariadb-dump matchup > matchup-$(date +%F).sql`, or just copy `/var/lib/mysql`. |
| **Do not** | Expose port 3306. MariaDB binds to `127.0.0.1`; only the web server is meant to be reached from outside. |
| **Growing later** | If you outgrow this box: `mariadb-dump` → import into any hosted MariaDB/MySQL and change `MARIADB_HOST`/`MARIADB_PORT` — no code changes. |
| **Size** | A profile row is a few hundred bytes; 1 GB of disk ≈ millions of rows. |

---

## 6. Scaling

The current app is stateless HTTP long-poll signaling against MariaDB/MySQL,
with media in Vercel Blob. The practical controls are:

- **Connection pool:** `MARIADB_POOL_SIZE` keeps `pool × warm instances` below
  the database's `max_connections`.
- **Storage capacity:** the admin Database card compares actual usage with
  `MARIADB_STORAGE_LIMIT_MB` (default 1 GB, matching common free tiers). The
  database is data-only — media is in Blob — so text data lasts a long time.
  Upgrade the plan in place, or move to a larger primary with `npm run db:copy`
  ([docs/SCALING.md](docs/SCALING.md) §6). Never split the same users across two
  primaries.
- **Read replica:** set `MARIADB_READ_HOST`; public feeds and anonymous creator
  cards use it, while auth, money, entitlement and signed-in viewer state stay
  on the primary.
- **Media lifecycle:** `/api/cron/media` plus the admin Database panel removes
  orphaned Blob objects and old unreferenced legacy rows.
- **Sharding:** a real migration project, not a flag. The phased plan (measure,
  move media, add replica, partition, shard by `account_id`, keep a global
  ledger) is in **[docs/SCALING.md](docs/SCALING.md)**.

The memory store remains only the local/dev fallback.

---

## 7. Testing

```bash
# Signaling: 16 checks — queue, match rule, signaling relay, spoofed-room drop,
# in-call `call:event` relay + whitelist, hang-up/disconnect notifications,
# re-match
npm run test:signaling

# Database: is the app linked to MariaDB, utf8mb4, writable?
# (exit 2 = not configured — see README → "Keeping the database on this PC")
npm run test:db

# Accounts: 28 checks — register, duplicate/weak-input rejection, wrong password,
# silent re-login, profile + preferences saved (incl. rename), logout, session
# revocation. Cleans up every row it created.
npm run test:auth

# Platform: 40 checks — commission split (15% of KES 400 → 340 to the
# creator), the M-PESA charge lifecycle (open → approved → settled, wallet
# credited once, double-approval is a no-op), paywall unlocking for the payer
# only, a creator seeing their own priced post as unlocked in every list,
# a paid media URL loading in a bare <img> via its signed `?t=` claim,
# payout requests reserving the balance, post hide/restore, rooms over
# signaling, commerce + mpesa settings and the audit trail. Needs the server
# running against MariaDB; cleans up every row it created.
npm run test:platform

# Admin dashboard: 26 checks — login, overview, the payment ledger
# (one reference → approve → premium granted once), ban/unban killing live
# sessions, settings round-trip, the audit trail.
#   ADMIN_USERNAME=… ADMIN_PASSWORD=… npm run test:admin
npm run test:admin

# UI smoke: 15 checks — every social tab renders signed-in with no runtime
# errors, the tab bar keeps its routes (incl. the 1v1 `/match`), the feed
# reads signed out and a protected page asks for credentials. Needs the
# system Chromium.
npm run test:ui

# End-to-end: 44 checks — two real Chromium pages, fake camera/mic, full
# Media relay both ways, controls, the in-call playground (chat
# round-trip, Spark card on both screens, duel resolving identically),
# hang-up → post-call screen → Next,
# re-match, share card ("Connection card ready" + the card shown back),
# /api/presence per-country counts, the live board (open → country rows →
# close), the Passport (stamp banner, collect-while-you-wait, book overlay),
# account create/reload/save/sign-out, telemetry
npm run test:e2e

```

`test:e2e` launches system Chromium (`/usr/bin/chromium`) through
`puppeteer-core` with `--use-fake-device-for-media-stream`, so it needs no real
camera.

**Point the same suite at the deployed stack** — the frontend on Vercel and the
server behind a tunnel are two different origins, so `APP_URL` (what the
browsers open) and `API_URL` (where `/health`, `/api/stats` and `/api/presence`
live) are set separately:

```bash
APP_URL=https://your-app.vercel.app \
API_URL=https://<tunnel>.trycloudflare.com \
node scripts/e2e.js
```

---

## 8. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "Camera / microphone blocked" | Grant permission in the address bar; serve over HTTPS (localhost is exempt). |
| "Unable to reach signaling server" banner | `CORS_ORIGIN` doesn't include your frontend URL, or the service is asleep. |
| Stuck on **Connecting**, then "Unable to connect" | The media relay could not exchange slices. Check the API/DB and the browser console; `curl /api/stats \| jq .calls.outcomes` shows how often this happens. Retry. |
| Connects but no audio | Browser tab autoplay policy; click the page once. Check the mic toggle (red = muted). |
| Works locally, fails in production | Mixed content (page served over HTTPS but `VITE_SIGNALING_URL` is `http://`). Always use `https://`. |
| High latency / choppy video | The app relay adds ~1–3 s. Lower the resolution cap in `LOCAL_MEDIA_CONSTRAINTS`, or move to a dedicated SFU for scale. |
| `npm run test:db` exits **2** | `MARIADB_*` not in `server/.env` — run the §5.5 step 2 command (or add the five lines by hand). |
| `test:db`: **cannot connect** | `sudo systemctl start mariadb`, or wrong `MARIADB_PORT`. `journalctl -u mariadb` has the details. |
| `Access denied for user 'matchup'@…` | Wrong password in `server/.env`, or the init script wasn't run — re-run `scripts/mariadb-init.sql` (it is idempotent). |
| `"store":"memory"` in `/api/stats` | The DB wasn't configured *or* was unreachable at boot — the app degrades instead of crashing. Check the `[store]` lines in the server log. |
| Emoji come out as `????` | The connection is not utf8mb4. The store forces `SET NAMES utf8mb4` on every connection; `npm run test:db` asserts all three charsets. |
| Table `profiles` doesn't exist | Start the server once — it creates the schema on boot (`CREATE TABLE IF NOT EXISTS`). |
| `"accounts":"memory"` in `/health` | MariaDB wasn't reachable at boot, so accounts live in memory and vanish on restart. Check the `[store]` / `[auth]` lines in the server log, then restart the service. |
| Sign-in returns **401** `Please sign in again` | The bearer token expired (30 days) or was revoked — sign in again. Clearing site data signs you out too; nothing else is lost. |
| Sign-in returns **409** `That username is already taken` | Usernames are unique case-insensitively (`Alice` = `alice`). Click **Sign in** instead. |
| Auth returns **429** `Too many attempts` | 20 credential attempts per minute per IP (`test:auth` + manual testing can use it up). Wait a minute. |
| `test:auth` leaves rows behind | It deletes exactly what it created and sweeps `authtest_%`/`e2e_%` rows older than an hour — a crash mid-run is cleaned up by the next run. |
| Board says **"Nobody from Europe is online"** | The counts only cover sockets that submitted a profile (`queue:join`) — a visitor who only opened the landing page has no country to count. Zero on a fresh deploy is correct, not a bug. |
| **Everyone gets "could not reach the server"** (e.g. on Create account) | The client has no reachable API: `VITE_SIGNALING_URL` is unset — deliberately, since the tunnel was removed — or points at a host that is down. Set it to your permanent API https URL in Vercel (Settings → Environment Variables), redeploy, and make sure the server's `CORS_ORIGIN` includes `https://matchup-mu.vercel.app`. |
| Board shows **"Live counts are unavailable"** | `GET /api/presence` unreachable for the same reason as above (API host unset or down), or the IP hit the 60/min budget (wait a minute). |

### Privacy notes

* Only public profile fields (username, age, gender, country) are ever shared with
  the partner — the age range and preferences stay server-side.
* Profiles are stored per session and auto-expire after 30 days (Mongo TTL index).
* Media is relayed by the app server; no STUN/TURN is involved.
* The live board publishes **sums only** — `/api/presence` returns a country code
  and a count, never a name, IP, session or timestamp (self-reported country, the
  same field matchmaking uses). The share card is rendered in your browser and
  uploaded nowhere: countries and duration, no names, no faces.

---

## 9. Reaching people (distribution)

Two different problems get confused constantly:

| | Question | Lever |
| --- | --- | --- |
| **Reach (technical)** | Can two browsers exchange media? | the app relay over HTTPS |
| **Distribution (growth)** | Does anyone ever hear about the app? | the playbook below |

The relay is already handled in §4.4/§5.4. Distribution is where the leverage is.

### 9.1 Globally, through browsers

1. **Ship the share loop first** — Web Share API on the call screen plus a link
   that pre-fills the lobby. One line of copy beats any banner: *"I just matched
   with a stranger — beat me."*
2. **Pair invite** — a URL that guarantees two friends match each other. Instant
   demo, inherently shareable, zero ad spend.
3. **Live social proof** — you already broadcast `presence.online` /
   `presence.looking`; surface them pre-lobby as *"142 people online right now"*.
4. **Geo-targeted short-form ads** — 1 km radius around your coverage area on
   Instagram/TikTok/X, hook over features: *"Tap once. Talk to someone real in
   10 seconds."*
5. **Local communities** — WhatsApp/Telegram/campus groups where your early
   users already are.

### 9.2 Locally, over your ISP's WiFi coverage

Your provider's footprint is a distribution asset — the app is just a URL, so
anything that puts that URL in front of a captive audience works:

1. **Captive-portal / hotspot splash page** — the highest-impact channel if you
   operate (or are authorized on) the network: one screen with the live counter,
   a 3-second preview and a QR code. *Only run this on networks you're authorized
   to configure, with a visible opt-out — intercepting other people's traffic is
   illegal in most places.*
2. **QR codes in physical hotspots** — cafés, campuses, hostels, waiting rooms
   inside the coverage area. A face + one line of copy + QR outperforms a banner
   because the friction is zero.
3. **Short memorable domain** — `matchup.app` style beats a long URL on posters
   and in conversation.
4. **Attention hooks that fit the product** — waiting-screen tension, a
   *"someone near you is looking now"* ticker, streaks, and a short reaction
   clip (with consent) as the ad creative.

### 9.3 Before spending on ads

> Step-by-step: [ADS.md](ADS.md) — AdSense vs. alternative networks, consent
> for EU visitors, and the Google/Meta/TikTok campaign playbook.

* A marketing page at `/` with a hero, live counter and one big **Start
  talking** button converts far better than dropping strangers into a camera
  prompt.
* Keep counter claims honest — social proof works, fabricated numbers backfire.
* You collect age/gender/country: publish a privacy policy and an age gate
  before running paid ads.
* Watch `GET /api/stats` → `calls.outcomes.successRate` while scaling. Growth
  that lands users on "Unable to connect" is wasted spend — improve onboarding
  and network guidance before buying more traffic.

### 9.4 Reaching one place (Europe-first) without fencing the app

Matching stays **global by design** — no country filter, no region lock. Two
shipped surfaces do the opposite: they make crossing borders the *product*, and
they tell a visitor whether anyone is awake near them.

1. **"Share this connection" (the card)** — after a real call, one button turns
   it into a story-format image: two flags, the distance between them, how long
   you talked, the link. Native share sheet on phones (Web Share API) →
   Instagram/WhatsApp story → link back. It only ever shows countries and
   duration, so it needs no consent from the other side beyond yours. Every
   story advertises the actual magic: *a Pole and a Portuguese stranger met at
   23:00 for no reason.*
2. **The live board** — lobby button or the shareable
   `https://matchup-mu.vercel.app/#europe` link. Honest, self-updating social
   proof (`GET /api/presence`), grouped *In Europe* / *Elsewhere*. Best ad copy
   there is, because it can't be faked — if it says 38, it's 38.
3. **Seed the density before you advertise.** A specific place only works if two
   people from it are online at the same time. Personally get 15–30 people from
   the target country online in one two-hour window first; a first-timer who
   matches in <15 s comes back, one who stares at a counter doesn't. Never pad
   the numbers — fabricated proof backfires.
4. **Aim at people who already want to talk to strangers**: Erasmus/exchange
   students (city WhatsApp & Telegram groups), language learners
   (Tandem/HelloTalk, `r/languagelearning`) and interrailing/backpackers —
   hostel notice boards and campus posters with a QR code convert better than
   a banner ad.
5. **Time it to their clock**: 20:00–23:00 CET is when the board shows Europe
   awake and when ad spend buys real concurrency.
6. **Next (not built)**: `?src=` attribution — one column recording which link
   or poster brought a visit, so `curl /api/stats` can eventually say *"17 from
   the campus QR, 3 from the reel."*
