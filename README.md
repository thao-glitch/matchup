# Matchup — 1v1 global video chat + a creator platform

A production-ready, peer-to-peer 1v1 video chat app — wrapped in a social
platform where creators post content, charge for it in KES and get paid over
M-PESA. Two strangers are matched by
preference and connected directly over WebRTC — **video/audio never touch the
server**; the server only introduces people and relays a few kilobytes of SDP/ICE.

```
  Browser A  ──WebSocket──▶  Signaling server (Node + Socket.io)  ◀──WebSocket──  Browser B
      │                            matchmaking + SDP relay                                │
      └──────────────────────── WebRTC (UDP, peer-to-peer, TURN as fallback) ──────────────┘
```

| Layer      | Tech                                                          |
| ---------- | ------------------------------------------------------------- |
| Frontend   | React 19 + Vite + TypeScript + Tailwind CSS v4                 |
| Signaling  | Node.js + Express 5 + Socket.io                                |
| Database   | MariaDB → MongoDB → in-memory (first one configured wins)      |
| NAT punch  | STUN + TURN (coturn / Twilio / Cloudflare — any one works)     |
| Deployment | **One container** — app + API + admin on Koyeb/Render/VPS ([DEPLOY.md](DEPLOY.md)) |

**Verified end-to-end**: 43/43 browser E2E checks (match → ICE → both-way video →
mute/camera → chat → Spark → rock-paper-scissors duel → hang-up → *Next* →
re-match → share card → live country board → the Passport → accounts →
telemetry), 46/46 when pinned through the TURN relay, 28/28 account checks,
32/32 platform checks (commission split, M-PESA charges, wallets, payouts),
26/26 dashboard checks, 16/16 signaling checks, plus a live STUN/TURN
`Allocate` verification. See [Testing](#7-testing).

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
Until Safaricom credentials are entered in **/admin → Settings**, the app runs
in *manual* mode: paybill + account number, and the owner approves each payment
from the dashboard. `/admin` also owns commerce switches, commission rate,
price caps, room moderation, the earnings ledger and payouts. The original 1v1
video app lives at `/match` — the emphasised centre tab.

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
│           ├── signaling.ts          # typed Socket.io client + event contract
│           ├── rooms.ts              # room socket client (mesh group calls)
│           ├── peer.ts               # RTCPeerConnection wrapper (the core)
│           ├── iceServers.ts         # STUN/TURN config fetched from the server
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
│   ├── server.js                    # Express + Socket.io + HTTP + auth routes
│   ├── render.yaml                  # Render blueprint (infra as code)
│   ├── .env.example
│   └── src/
│       ├── protocol.js              # event names + payload docs (mirrors client)
│       ├── matchmaking.js            # validation + symmetric match rule
│       ├── matchmaker.js             # FIFO queue, rooms, signal relay, presence
│       ├── accounts.js               # register/login/sessions (scrypt, bearer tokens)
│       ├── payments.js               # premium paybill intents (manual approval)
│       ├── commerce.js               # posts, paywall, charges, commission split, wallets, rooms
│       ├── socialStore.js            # social tables (posts, charges, wallets, rooms…)
│       ├── mpesa.js                  # Daraja STK push + callback parsing
│       ├── rooms.js                  # RoomHub — mesh signaling for group calls
│       ├── settings.js               # payment/features/commerce/mpesa config + sanitizers
│       ├── admin.js                  # every dashboard operation + audit trail
│       ├── iceConfig.js              # STUN + Twilio/coturn/static TURN resolution
│       ├── telemetry.js              # per-call outcome aggregation (/api/stats)
│       ├── mariaStore.js             # local MariaDB backend (profiles, accounts, social tables)
│       └── store.js                  # MariaDB → MongoDB → in-memory facade
│
├── scripts/                         # operations + verification
│   ├── mariadb-init.sql             # one-time: create the database + app user
│   ├── local.sh                     # start / stop / status the whole stack (incl. tunnel URL sync)
│   ├── turn-up.sh                   # (re)create coturn with production settings
│   ├── test-signaling.js            # 16 checks against the live server
│   ├── test-db.js                   # is the app really linked to the database?
│   ├── test-auth.js                 # 28 checks: the whole account lifecycle
│   ├── test-admin.js                # 26 checks: the dashboard (login, ledger, bans)
│   ├── test-platform.js             # 32 checks: posts, M-PESA charges, commission, wallets
│   ├── test-ui.js                   # 15 checks: the social shell renders, tabs resolve
│   ├── test-turn.js                 # real STUN Allocate against your TURN server
│   ├── e2e.js                       # 43 checks (46 with E2E_RELAY=1): Chromium + WebRTC
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
| `TURN_URLS`          | prod     | TURN endpoint(s) — see [Deploying TURN](#54-deploying-turn)        |
| `TURN_SECRET`        | prod     | coturn REST API: must equal coturn's `static-auth-secret`          |
| `TURN_CREDENTIAL_TTL_SEC` | no  | TURN credential lifetime in seconds (default `600`)                |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | alt | Static credentials (instead of `TURN_SECRET`)              |
| `TWILIO_ACCOUNT_SID` | alt      | Twilio Network Traversal (short-lived TURN credentials)            |
| `TWILIO_AUTH_TOKEN`  | alt      | ↑                                                                |
| `PRESENCE_INTERVAL_MS` | no     | Live counter push interval (default `5000`)                        |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | no | Creates the first `/admin` dashboard login on the very first boot (10+ chars). Ignored afterwards — the dashboard owns its credentials |

### `client/.env.local`

| Variable           | Purpose                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `VITE_SIGNALING_URL` | Absolute URL of the signaling server. **Empty ⇒ same origin** (dev proxy) |
| `VITE_ICE_URL`     | Override the ICE config endpoint (defaults to `<VITE_SIGNALING_URL>/api/ice`) |

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

A room id is generated and **one side is flagged `initiator: true`** — that side
creates the SDP offer, which is what prevents offer/answer glare.

### 4.2 Signaling contract

Defined once in `client/src/lib/signaling.ts`, mirrored in `server/src/protocol.js`:

| Direction | Event            | Payload                                   |
| --------- | ---------------- | ----------------------------------------- |
| C → S     | `queue:join`     | `{ profile }`                             |
| C → S     | `queue:leave`    | —                                         |
| C → S     | `signal:data`    | `{ roomId, kind: offer\|answer\|candidate, payload }` |
| C → S     | `call:end`       | —                                         |
| S → C     | `match:found`    | `{ roomId, peer, initiator }`             |
| S → C     | `match:waiting`  | `{ looking, online }`                     |
| S → C     | `signal:data`    | same as C → S (relayed to the partner)    |
| S → C     | `peer:left`      | `{ roomId, reason: ended\|disconnected }` |
| S → C     | `presence`       | `{ looking, online }`                     |
| S → C     | `server:error`   | `{ code, message }`                       |

The relay only forwards messages whose `roomId` matches the sender's room, is rate
limited (80 msgs/s/socket) and capped at 1 MB per packet.

### 4.3 WebRTC (`client/src/lib/peer.ts`)

A small, dependency-free `RTCPeerConnection` wrapper instead of `simple-peer`
(unmaintained, hides exactly the state we must surface). It implements:

* **Perfect negotiation** — the W3C "polite peer" pattern, so simultaneous offers
  resolve instead of deadlocking.
* **Candidate buffering** — ICE candidates that arrive before the remote
  description used to be dropped ("connects 1 time in 3" on high-RTT links).
* **ICE restarts** — Wi-Fi↔LTE handoffs or `disconnected` blips recover
  transparently (max 2 restarts) before giving up.
* **Watchdog** — ICE can hang forever in `checking`; after 20 s we restart, after
  2 more attempts we surface **"Unable to connect"** with *Try again* / *Find
  someone else*.
* **Path readout** — `getStats()` shows `Local network` / `Direct P2P` / `TURN
  relay` plus RTT in the call header, so you can *see* whether traffic is P2P.

Connection states → UI: `connecting` · `connected` · `reconnecting` · `failed`.

### 4.4 Global optimization (STUN/TURN)

```
STUN  → discovers each side's public IP:port. Free, global, enough for ~85-90% of NATs.
TURN  → relays the media when discovery fails. REQUIRED for symmetric NAT, double NAT,
        CGNAT and strict corporate firewalls, otherwise those users never connect.
```

* Google STUN (`stun:stun.l.google.com:19302` …) + Twilio's global STUN are
  configured in `server/src/iceConfig.js`.
* The browser fetches `GET /api/ice` at call time, so **no secret ships in the JS
  bundle**. Resolution priority: **Twilio Network Traversal** → **coturn REST API
  (`TURN_SECRET`)** → **static `TURN_*` credentials** → STUN-only fallback. Failures
  degrade instead of 500ing, so a TURN outage never takes the app down.
* Which mode am I in? `GET /health` → `ice: { source, turnConfigured, turnHosts }`.
* ⚠️ With none of those set you are running **STUN-only**: most users are fine, but
  roughly one in ten on strict networks gets "Unable to connect". See
  [Deploying TURN](#54-deploying-turn) — it is a ~30 minute job.

**Measuring whether TURN is paying off.** Every call sends one `call:report`
(selected ICE candidate pair, RTT, duration, credential source). They aggregate in
`GET /api/stats` → `calls`:

```jsonc
{
  "outcomes": { "connected": 42, "failed": 3, "successRate": 93.3 },
  "paths":    { "host": 4, "srflx": 31, "relay": 7, "prflx": 0, "unknown": 0 },
  "relayShare": 18.4,            // share of connected calls that needed TURN
  "iceSources": { "rest-secret": 45, "stun-only": 0, ... },
  "rttMs": { "samples": 42, "avg": 47 }
}
```

`outcomes.failed` is the number that matters: every one of those is a user who saw
"Unable to connect". `paths.relay` tells you how many of your working calls TURN is
carrying (and therefore what it costs you in bandwidth).

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
channel can never crowd out the SDP relay. No server game state: everything
shared is derivable from the same events both sides already see.

### 4.8 Admin dashboard & paybill payments

Two features that live entirely behind the same process — no extra service:

**`/admin`** — a login-protected dashboard (`server/src/admin.js` +
`client/src/admin/`): live users and queue, call telemetry, the paybill ledger,
feature switches (ads / sign-ups / payments / **maintenance**), ban & premium
controls and an audit trail of every action. Admins live in their own `admins`
table with their own scrypt hashes and 12-hour sessions — being a user of the
app can never make you an admin of it.

**Paybill payments** (`server/src/payments.js` + `client/src/lib/payments.ts`)
— a visitor signs in, the lobby shows *their* unique Account Number (`MU1042`)
plus the paybill number and price you configured, they pay from any bank app or
M-PESA, press **I have paid**, and you approve the row in `/admin` → Payments.
Approval stamps premium on the account. Everything (bank, paybill, price,
premium length, wording) is edited in `/admin` → Settings and applies live.
Full guide, including what to ask the bank for: [docs/PAYMENTS.md](docs/PAYMENTS.md).

Matchmaking enforces all of it: a banned account cannot log in *or* queue
(username and IP), a `features.maintenance` flip pauses the queue instantly,
and `GET /api/config` hands the switches to the lobby.

---

## 5. Deployment

> **Run it fully independently → [DEPLOY.md](DEPLOY.md)** — one container (app +
> API + WebSocket + `/admin`) on free Koyeb, free Aiven MySQL, free Cloudflare
> TURN. No credit card, no GitHub, no separate frontend host, and your PC can
> be switched off. The sections below cover the classic paths (Render
> blueprint, TURN, local MariaDB).
>
> **Payments → [docs/PAYMENTS.md](docs/PAYMENTS.md)** — accepting money through
> your DTB paybill, and what to ask the bank for.
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
   * `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` (**recommended**)
4. Copy the service URL, e.g. `https://matchup-signaling.onrender.com`.
5. Smoke-test: `curl https://…/health` → `{"status":"ok",…}`.

> Render/Railway terminate TLS and proxy WebSockets out of the box — Socket.io
> needs no extra configuration on a single instance.

### 5.2 Frontend → Vercel

> **Storing data on your own PC?** Then the signaling server runs here too
> instead of Render — follow [§5.5](#55-keeping-the-database-on-this-pc-mariadb)
> and come back only for steps 1–4 below, with
> `VITE_SIGNALING_URL` set to your **tunnel URL**.

1. Vercel → **Add New → Project** → import the repo.
2. Set **Root Directory** to `client` (Settings → General), framework preset
   *Vite* (auto-detected), build `npm run build`, output `dist`.
3. Environment variable: `VITE_SIGNALING_URL=https://matchup-signaling.onrender.com`.
4. Deploy. `client/vercel.json` already handles the SPA rewrite and long-lived
   asset caching.
5. Back in Render, set `CORS_ORIGIN` to the final Vercel URL (comma-separate
   multiple preview URLs) — otherwise Socket.io will reject the connection.

**Order matters**: deploy the backend first, then the frontend, then update
`CORS_ORIGIN`. Redeploying the frontend after that picks up the env var.

**No GitHub repo?** Deploy straight from this machine — the Vercel CLI needs no
repository:

```bash
cd ~/Desktop/matchup/client
npx vercel login                                  # once per machine (browser opens)
npx vercel link --yes --project matchup           # create + link the project
npx vercel env add VITE_SIGNALING_URL production   # paste your tunnel URL
npx vercel --prod                                 # first deploy (builds with the URL)
```

`VITE_*` values are baked in **at build time**, so the env var must exist before
the deploy that should use it. Then copy the printed
`Production: https://….vercel.app` into `CORS_ORIGIN` in `server/.env` and
restart the server — with `CORS_ORIGIN=*` the app still works, but pinning the
exact origin is what you want in production.

### 5.3 Standalone (single container, single URL) — the default

The root `Dockerfile` builds the client **inside** the image and copies the
bundle next to the server, so one process serves the app, the API, the
WebSocket and `/admin` from one origin:

```bash
docker build -t matchup .          # ~1 min warm, ~2 cold
docker run -p 4000:4000 --env-file prod.env matchup
open http://localhost:4000        # the whole app
```

`VITE_SIGNALING_URL` is left empty on purpose: the bundle calls `/api`,
`/api/ice` and `/socket.io` on its own origin. Deploy the same image with
`./scripts/deploy.sh` — [DEPLOY.md](DEPLOY.md) walks through Koyeb end to end.
If you'd rather build the client on the host (`cd client && npm run build`),
the server still auto-detects `client/dist` and serves the SPA exactly as before.

### 5.4 Deploying TURN

TURN is the difference between "works for most people" and "works for everyone".
Pick one:

| | Setup | Cost | Best for |
| --- | --- | --- | --- |
| **A. Self-hosted coturn** | ~30 min (below) | flat ~$5/mo + bandwidth | production, predictable spend |
| **A′. coturn on this PC** | `scripts/turn-up.sh` + one router rule | free (your own line) | **this deployment** — needs a real public IPv4 |
| **B. Twilio Network Traversal** | 2 env vars | per-request | zero ops |
| **C. Hosted TURN (Metered, Cloudflare Calls…)** | 3 env vars | free tier → per-minute | quick start |

All three end in the same env vars on the signaling server — the client never
changes.

#### Option A — coturn, step by step (recommended)

**1. Server.** Any VPS with a public IP (Hetzner, DigitalOcean, OVH, Contabo…).
1 vCPU / 1 GB is plenty; **bandwidth is the real budget**: a relayed 1v1 call
pushes ~2.25 GB/hour through the box (both directions), so a 1 TB plan covers
≈ 440 relayed hours.

**2. Install and enable**

```bash
sudo apt-get update && sudo apt-get install -y coturn
sudo sed -i 's/#TURNSERVER_ENABLED.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

**3. Generate the shared secret** (this exact value goes to the app too):

```bash
openssl rand -hex 32     # → e.g. 9f2c…c71a
```

**4. Configure `/etc/turnserver.conf`**

```ini
listening-port=3478
tls-listening-port=5349

# Credentials: short-lived, minted by the signaling server (TURN REST API).
lt-cred-mech
use-auth-secret
static-auth-secret=9f2c…c71a          # ← same value as TURN_SECRET
realm=turn.example.com                 # ← hostname used in TURN_URLS

# Reachability: TURN over TCP/TLS saves users on UDP-blocking networks.
fingerprint
no-multicast-peers

# Relay port range (must be open in the firewall; narrow it to shrink the rule).
min-port=49152
max-port=65535

# If this box already runs a web server, don't fight it for :443 — use 5349
# (turns:…:5349?transport=tls) instead of 443.
```

> Never add `--allow-loopback-peers` in production: it exists only so the local
> E2E relay test can run two browsers on one machine.

**5. Firewall**

```bash
sudo ufw allow 3478/udp && sudo ufw allow 3478/tcp   # STUN/TURN
sudo ufw allow 5349/tcp                              # TURN over TLS
sudo ufw allow 49152:65535/udp                       # relayed media
# Optional, only if you serve turns: on 443 —  sudo ufw allow 443/tcp
```

**6. TLS certificate** (only for `turns:` — plain `turn:` works without it):

```bash
sudo apt-get install -y certbot
sudo certbot certonly --standalone -d turn.example.com
# then in turnserver.conf:
#   cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
#   pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
```

**7. DNS:** `turn.example.com` → A record → the VPS public IP.

**8. Start it:** `sudo systemctl enable --now coturn` (config edits need a restart).

**9. Point the signaling server at it** (`server/.env`, or Render → Environment):

```bash
TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tls
TURN_SECRET=9f2c…c71a
# TURN_CREDENTIAL_TTL_SEC=600        # optional, credential lifetime
```

Restart the server. `GET /health` must now say:

```jsonc
"ice": { "source": "rest-secret", "turnConfigured": true, "turnHosts": ["turn.example.com:3478"] }
```

**10. Verify — green only when the relay truly works end to end:**

```bash
# 1. Real STUN Allocate + CreatePermission against your TURN server:
npm run test:turn

# 2. Two browsers forced through TURN, media must flow:
npm run test:e2e:relay

# 3. Manual: open your app with ?relay=1 — the call header must read
#    "TURN relay" (without it: "Local network" / "Direct P2P").

# 4. Watch the mix:  curl -s <server>/api/stats | jq .calls
```

> **Local dry run (no VPS needed).** Rehearse the whole flow with:
> `podman run -d --name turn --network=host coturn/coturn -n -v --fingerprint
> --use-auth-secret --static-auth-secret=<secret> --realm=matchup.test
> --listening-port=3478 --min-port=49152 --max-port=65535 --allow-loopback-peers`
> — then set `TURN_URLS=turn:127.0.0.1:3478?transport=udp` and run
> `npm run test:turn`. The `--allow-loopback-peers` flag is only needed because
> both test browsers sit on `127.0.0.1`; coturn rejects loopback peers by default
> (`403 Forbidden IP`) — a symptom you will only ever see locally.

#### Option A′ — coturn on *this* PC (what this deployment runs)

No VPS is needed when your own line has a **real public IPv4**. Check with
`curl -4 ifconfig.me`: if the answer falls inside `100.64.0.0/10` you're behind
CGNAT and inbound ports are impossible — anything else can be forwarded. This
machine qualifies (`102.212.238.161`), so the relay sits here next to the
signaling server and the database.

**1. Container** — `scripts/turn-up.sh` creates it with the three settings that
separate a production relay from a local toy:

```bash
scripts/turn-up.sh      # idempotent: no-op when the config already matches
```

| setting | why it matters |
| --- | --- |
| `--external-ip=<public>/<private>` | without it coturn advertises `192.168.0.101` as the relay address, which remote peers can't reach — the relay is configured, working, and *never gets used* |
| `--min-port=49152 --max-port=49408` | 257 ports instead of the default 16 384 — small enough for a consumer router (~128 concurrent relays; raise both ends as you grow) |
| `--total-quota=40` + `--no-cli` + `--no-multicast-peers` | caps relay usage on a home uplink, keeps the telnet CLI closed |

`--allow-loopback-peers` **stays on** here, unlike a VPS: both E2E relay
browsers run on this machine, and only private-source callers are ever handed
the loopback URL (see step 3).

**2. Auto-start** — `matchup-turn.service` (systemd user unit, **enabled**)
runs `turn-up.sh` before following the container's logs. The public IP is
re-detected on every run, so a changed ISP address is picked up at boot.

**3. Two URL lists** (`server/.env`) — `/api/ice` serves them by source
address:

```bash
TURN_URLS=turn:102.212.238.161:3478?transport=udp,turn:102.212.238.161:3478?transport=tcp
TURN_URLS_LOCAL=turn:192.168.0.101:3478?transport=udp,turn:127.0.0.1:3478?transport=udp
TURN_SECRET=matchupdevsecret
```

A browser arriving through the tunnel gets **only the public addresses**. A
request from a loopback/LAN source — `npm run test:turn`, `npm run dev`, the
local E2E relay run — gets `TURN_URLS_LOCAL` first, because home routers
rarely hairpin NAT (your public address doesn't work from inside your own
network) and a private address is useless — and an unnecessary leak — to
everyone else.

**4. Router port forwarding — the one step only you can do.** In your router
(typically `http://192.168.0.1`), forward to `192.168.0.101`:

| Protocol | Port(s) | → Host | Carries |
| --- | --- | --- | --- |
| UDP | 3478 | 192.168.0.101 | STUN/TURN signalling |
| TCP | 3478 | 192.168.0.101 | TURN on networks that block UDP |
| UDP | 49152-49408 | 192.168.0.101 | relayed media |

Give this PC a **DHCP reservation** so `192.168.0.101` never drifts.

**5. Verify — and only an *outside* test counts:**

```bash
npm run test:turn        # run from here → checks the LAN endpoint,
                         # "allocation granted → 102.212.238.161:49xxx"
                         # proves external-ip, not internet reachability
npm run test:e2e:relay   # two browsers, media forced through the relay
```

Then open `https://your-app.vercel.app/?relay=1` **on a phone using mobile
data**, match it with this PC (also `?relay=1`), and confirm the call header
reads **"TURN relay"**. That is the test that proves port 3478 + the relay
range are reachable from the internet — no local command can.

**6. When your ISP changes your IP:** re-run `scripts/turn-up.sh`, then
`systemctl --user restart matchup`. The relay address is read by the server at
runtime, so **no Vercel redeploy** is required (unlike `VITE_SIGNALING_URL`).

> A relayed 720p call pushes ≈2.25 GB/hour through your uplink; `--total-quota`
> and the fact that TURN is only a fallback keep that in check while the app is
> small. Graduate to Option A (a VPS) when traffic outgrows the line.

#### Option B — Twilio Network Traversal

```bash
TWILIO_ACCOUNT_SID=ACxxxx
TWILIO_AUTH_TOKEN=xxxx
```

That's it: Twilio's `/Tokens.json` response is minted, cached and refreshed a
minute before expiry; the client picks it up through `/api/ice`.

#### Option C — hosted TURN with static credentials

```bash
TURN_URLS=turn:turn.example.com:3478?transport=udp
TURN_USERNAME=matchup
TURN_CREDENTIAL=<from-your-provider>
```

### 5.5 Keeping the database on this PC (MariaDB)

This is the setup where **your data never leaves this machine**: MariaDB stores
everything under `/var/lib/mysql` and grows with the app, while the frontend is
still shipped to Vercel.

**Why the signaling server also has to run here:** Vercel serves static files
and short-lived functions — Socket.io needs a long-lived process — and a
database on this machine is only reachable from this network. So:

```
browser ──▶ Vercel (static client)
                 │  VITE_SIGNALING_URL
                 ▼
        free tunnel (cloudflared / ngrok)   ← public HTTPS, outbound only
                 │
                 ▼
        this PC, localhost:4000  (Express + Socket.io)
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

**4. Reach it from the Vercel frontend.** The server needs a public HTTPS URL.
A tunnel needs no router/port-forwarding configuration and never exposes
MariaDB:

```bash
cloudflared tunnel --url http://localhost:4000     # free → prints an https://…trycloudflare.com URL
# or:  ngrok http 4000
```

* Quick tunnels get a **new URL on every start** — for a stable address use a
  named Cloudflare tunnel with a domain you own (or point a subdomain at your
  public IP).
* Set `VITE_SIGNALING_URL=<that URL>` in Vercel (Settings → Environment
  Variables) and redeploy the client.
* Set `CORS_ORIGIN=https://your-app.vercel.app` in `server/.env`, then restart
  the server — otherwise Socket.io rejects the browser.

**5. Keep it running.** MariaDB starts at boot (`systemctl enable` above). For
the app server, add a **user** service. It deliberately *waits for MariaDB*:
a user unit cannot order itself against a system unit, and without the wait the
server can boot first and silently fall back to the in-memory store.

```ini
# ~/.config/systemd/user/matchup.service
[Unit]
Description=Matchup signaling server (WebRTC 1v1 video chat)
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

**6. The relay, the tunnel, and one command for everything.** The running stack
is four units:

| Unit | Enabled? | Why |
| --- | --- | --- |
| `mariadb` (system) | ✅ | owns your data |
| `matchup` (user) | ✅ | waits for MariaDB, then serves API + signaling |
| `matchup-turn` (user) | ✅ | coturn — `scripts/turn-up.sh` first, then follows its logs |
| `matchup-tunnel` (user) | ✅ | a quick tunnel mints a new address every start, so its `ExecStartPost` runs `local.sh sync` — a changed URL is pushed to Vercel and the client redeployed automatically (step-by-step trail in `.sync.log`) |

`scripts/local.sh` starts, repairs and reports the whole stack:

```bash
scripts/local.sh status                 # all four units, health, tunnel URL, last synced
scripts/local.sh start                  # start/repair server + coturn + tunnel
scripts/local.sh start --sync-vercel    # …and push a changed URL to Vercel + redeploy
scripts/local.sh sync                   # push the current tunnel URL to Vercel (what ExecStartPost runs)
scripts/local.sh stop                   # stops server/relay/tunnel (MariaDB keeps running)
```

**Operational notes**

| | |
| --- | --- |
| **Downtime** | The app is up while *this PC* is up. Vercel stays reachable regardless, but matching needs the signaling server + tunnel. |
| **Backups** | The DB is now a file on your disk — cron `mariadb-dump matchup > matchup-$(date +%F).sql`, or just copy `/var/lib/mysql`. |
| **Do not** | Expose port 3306. MariaDB binds to `127.0.0.1`; only the web server goes through the tunnel. |
| **Growing later** | If you outgrow this box: `mariadb-dump` → import into any hosted MariaDB/MySQL and change `MARIADB_HOST`/`MARIADB_PORT` — no code changes. |
| **Size** | A profile row is a few hundred bytes; 1 GB of disk ≈ millions of rows. |

---

## 6. Scaling

The queue lives in memory, which maps 1:1 to a single Node process (that is
exactly what a single Render instance gives you). To go horizontal:

1. `npm i @socket.io/adapter-redis` and pass an adapter to `new Server(…)`.
2. Add `@socket.io/sticky` (or enable sticky sessions on your load balancer) —
   Socket.io requires it for polling fallbacks.
3. Move the queue into Redis (`LRANGE`/`LPUSH`/`SREM` with the same match rule),
   keeping `Matchmaker`'s public API unchanged.

MongoDB (via `MONGODB_URI`) is already wired for persistence; the memory store is
only the dev fallback.

---

## 7. Testing

```bash
# Signaling: 16 checks — queue, match rule, SDP relay, spoofed-room drop,
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

# Platform: 32 checks — commission split (15% of KES 400 → 340 to the
# creator), the M-PESA charge lifecycle (open → approved → settled, wallet
# credited once, double-approval is a no-op), paywall unlocking for the payer
# only, payout requests reserving the balance, post hide/restore, rooms over
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

# TURN: real STUN Allocate + CreatePermission against the configured relay
# (exit 2 = TURN not configured — see README → "Deploying TURN")
npm run test:turn

# End-to-end: 43 checks — two real Chromium pages, fake camera/mic, full
# WebRTC handshake both ways, controls, the in-call playground (chat
# round-trip, Spark card on both screens, duel resolving identically),
# hang-up → post-call screen → Next,
# re-match, share card ("Connection card ready" + the card shown back),
# /api/presence per-country counts, the live board (open → country rows →
# close), the Passport (stamp banner, collect-while-you-wait, book overlay),
# account create/reload/save/sign-out, telemetry
npm run test:e2e

# End-to-end through the TURN relay: 46 checks — same as above plus
# `?relay=1` (ICE pinned to TURN) and assertions that media really relays
npm run test:e2e:relay
```

`test:e2e` / `test:e2e:relay` launch system Chromium (`/usr/bin/chromium`)
through `puppeteer-core` with `--use-fake-device-for-media-stream`, so they need
no real camera. The relay variant requires TURN to be configured.

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
| Stuck on **Connecting**, then "Unable to connect" | Almost always a NAT/firewall problem → [Deploying TURN](#54-deploying-turn). Check the header readout: if it never leaves `Connecting`, ICE found no path. `curl /api/stats \| jq .calls.outcomes` shows how often this happens. |
| Connects but no audio | Browser tab autoplay policy; click the page once. Check the mic toggle (red = muted). |
| Works locally, fails in production | Mixed content (page served over HTTPS but `VITE_SIGNALING_URL` is `http://`). Always use `https://`. |
| High latency / choppy video | Check the RTT readout; lower the resolution cap in `LOCAL_MEDIA_CONSTRAINTS`, or add a closer TURN region. |
| `npm run test:turn` exits **2** | TURN not configured — `/api/ice` is serving STUN-only. Set `TURN_URLS` + `TURN_SECRET` (or `TWILIO_*`). |
| `test:turn` fails with **401** | `TURN_SECRET` ≠ coturn's `static-auth-secret`, or the client minted the username timestamp as *issue* time instead of *expiry*. Compare `curl /api/ice` with `static-auth-secret` in `turnserver.conf`. |
| `test:turn` times out on Allocate | coturn not reachable: port 3478/udp blocked, wrong `TURN_URLS` host, or the service isn't running (`journalctl -u coturn`). |
| Browser `?relay=1` never connects, coturn logs **403 Forbidden IP** | coturn refuses loopback peers (local testing only) → add `--allow-loopback-peers`. Never do this on a VPS; the PC deployment in [A′](#option-a-coturn-on-this-pc-what-this-deployment-runs) keeps it on purpose, because only private-source callers are ever handed the loopback URL. |
| `test:turn` passes but **remote** users still can't relay | Reachability, not credentials: 3478 (udp+tcp) and 49152-49408/udp aren't forwarded to `192.168.0.101`, or you're behind **double NAT** (the router's WAN is `10.x` / `192.168.x` / `100.64.x`). The only proof that counts is from outside: a phone on **mobile data** opening `?relay=1` must show **"TURN relay"**. |
| `test:turn` reports it tested `turn:192.168.0.101…` | Expected — `/api/ice` is source-aware: callers from a private address get `TURN_URLS_LOCAL` first (your public address doesn't hairpin through most home routers). Remote browsers only ever receive `TURN_URLS`. |
| Relay works but the bill is scary | `curl /api/stats \| jq .calls` → `relayShare` tells you what share of traffic you pay for. `srflx`/`host` are free. |
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
| **Everyone gets "could not reach the server"** (e.g. on Create account) | The site is calling a dead tunnel URL — typical after a reboot or tunnel restart. `scripts/local.sh status`: if `tunnel :` and `synced :` differ, run `scripts/local.sh sync`. The tunnel unit syncs itself now; if it didn't, `.sync.log` shows the step it died on (expired Vercel auth → `cd client && npx vercel login`, then sync again). |
| Board shows **"Live counts are unavailable"** | `GET /api/presence` unreachable: stale tunnel URL in `VITE_SIGNALING_URL` → `scripts/local.sh sync`, or the IP hit the 60/min budget (wait a minute). |

### Privacy notes

* Only public profile fields (username, age, gender, country) are ever shared with
  the partner — the age range and preferences stay server-side.
* Profiles are stored per session and auto-expire after 30 days (Mongo TTL index).
* Media is peer-to-peer; the server relays signaling only.
* The live board publishes **sums only** — `/api/presence` returns a country code
  and a count, never a name, IP, session or timestamp (self-reported country, the
  same field matchmaking uses). The share card is rendered in your browser and
  uploaded nowhere: countries and duration, no names, no faces.

---

## 9. Reaching people (distribution)

Two different problems get confused constantly:

| | Question | Lever |
| --- | --- | --- |
| **Reach (technical)** | Can two browsers build a video path? | STUN + [TURN](#54-deploying-turn) |
| **Distribution (growth)** | Does anyone ever hear about the app? | the playbook below |

STUN/TURN is already handled in §4.4/§5.4. Distribution is where the leverage is.

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
  that lands users on "Unable to connect" is wasted spend — TURN is the fix.

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
