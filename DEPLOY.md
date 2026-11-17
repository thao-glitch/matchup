# Running Matchup standalone (one container, one URL, no PC required)

Matchup ships as **a single container**: the React app, the API, the HTTP
signaling + media relay and the `/admin` dashboard all come out of one
`node server.js` process. There is no separate frontend host, nothing to keep in
sync and no CORS to configure — the browser talks to one origin for everything.

| Piece | Where | Cost |
| --- | --- | --- |
| **App + API + admin** (this repo, one image) | **Koyeb** — free web service | free |
| Database (accounts, passports, payments, settings) | **Aiven for MySQL** — free tier, no card | free |
| Image registry | **Docker Hub** — free | free |

> Media is **relayed by this container** over the same HTTPS long-poll channel
> as signaling. There is no STUN, no TURN and no UDP port to open. Budget for
> the relay's bandwidth: video/audio now pass through the server.

---

## 0. One-time: what you need

- A **Docker Hub** account (email, no card): https://hub.docker.com
- A **Koyeb** account (any sign-in, no card): https://app.koyeb.com
- An **Aiven** account (email or Google, no card): https://aiven.io

Fill these into `.deploy.env` in the repo root (it stays on your machine and is
never committed — it is in `.gitignore` and `.dockerignore`):

```bash
DOCKERHUB_USER=mauru2df
DOCKERHUB_TOKEN=dckr_pat_xxxxxxxx        # hub.docker.com → settings → security → new token
DOCKERHUB_REPO=mauru2df/matchup
KOYEB_TOKEN=                              # app.koyeb.com → account → API tokens

MARIADB_HOST=…        # Aiven → your service → connection information
MARIADB_PORT=…
MARIADB_USER=avnadmin
MARIADB_PASSWORD=…
MARIADB_DATABASE=defaultdb
MARIADB_SSL=true

# Optional object storage for post media (production recommended):
# BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...
ADMIN_USERNAME=owner                      # first /admin login (used once, at first boot)
ADMIN_PASSWORD=choose-a-long-secret-here  # 10+ characters
```

---

## 1. Database — Aiven free MySQL (5 min)

1. Sign up at **https://aiven.io** (email or Google — *no credit card*).
2. **Create service → MySQL → Plan: Free → Create.** Wait ~2 minutes.
3. Open the service → **Overview → Connection information** and copy the host,
   port, password and database name (`defaultdb`) into `.deploy.env`.
4. Nothing else: the app creates its own tables at boot, and creates the
   database itself if it is missing.

## 2. Build + push + deploy (one command)

```bash
cd ~/Desktop/matchup
./scripts/deploy.sh
```

That builds the standalone image (client bundle compiled inside the image, then
copied next to the server), tags it `docker.io/YOURUSER/matchup:latest`, pushes
it, and — if `KOYEB_TOKEN` is set — asks Koyeb to pick up the new image.

> Every future deploy is the same one command. Locally the CLI is `docker`;
> the build takes ~1 minute warm, ~2 cold.

## 3. Koyeb — create the service (10 min, once)

1. **Create App → Web Service → Container image** → `docker.io/YOURUSER/matchup:latest`.
2. Pick a **free** region (Frankfurt or Washington, D.C.).
3. Add the environment variables:

   | Key | Value |
   | --- | --- |
   | `MARIADB_HOST` / `MARIADB_PORT` / `MARIADB_USER` / `MARIADB_PASSWORD` / `MARIADB_DATABASE` / `MARIADB_SSL` | from `.deploy.env` (Aiven) |
   | `ADMIN_USERNAME` | your dashboard username |
   | `ADMIN_PASSWORD` | your dashboard password (10+ chars) |
   | `BLOB_READ_WRITE_TOKEN` | Vercel Blob read/write token; keeps uploads out of MariaDB. Connect a Blob store in Vercel → Storage → Connect to Project. |
   | `MARIADB_POOL_SIZE` | *optional* — connections per instance (default `5`; keep pool × warm instances below `max_connections`) |
   | `MARIADB_STORAGE_LIMIT_MB` | *optional* — disk budget shown in `/admin` (default `1024`; display-only, raise it when the plan changes) |
   | `MARIADB_READ_HOST` / `MARIADB_READ_PORT` / `MARIADB_READ_USER` / `MARIADB_READ_PASSWORD` | *optional* — read replica; public feeds use it and fall back to the primary if it is down |
   | `CRON_SECRET` | authorizes the daily `/api/cron/media` lifecycle sweep |
   | `MEDIA_ORPHAN_GRACE_HOURS` / `MEDIA_RETENTION_DAYS` | *optional* — Blob orphan grace (24h) and legacy DB retention (30d) |
   | `CORS_ORIGIN` | *optional* — only needed if you later serve the client from a second origin |

4. Health check: **HTTP, path `/health`**. Deploy.

**Verify:**

```bash
curl -s https://<app>-<id>.koyeb.app/health
# {"status":"ok","store":"maria","accounts":"maria", …}
```

`store:maria` proves the database is live and the schema was created for you.

## 4. Network connectivity (app-server relay)

Video, audio and the in-call chat travel through the app's HTTP relay. The
browser records small camera/mic slices and posts them to `/api/rt/emit`; the
server forwards them to the partner's long-poll inbox. No STUN/TURN service,
UDP port or public IP is required. Calls that cannot start fail cleanly with
**Unable to connect**, and the user can retry. Confirm the mode with:

```bash
curl -s https://<app>-<id>.koyeb.app/health | jq .ice
# { "source": "relay", "transport": "http-long-poll", "cachedUntil": null }
```

The trade-off is latency (roughly 1–3 seconds) and server bandwidth. Size the
container and database for the expected media volume.

## 5. First admin login (2 min)

Open `https://<app>-<id>.koyeb.app/admin` and sign in with `ADMIN_USERNAME` /
`ADMIN_PASSWORD` from `.deploy.env`. From then on the dashboard owns its own
credentials — change the password in **Settings**, not in the environment.

The dashboard gives you: live users and queue, the call telemetry, the
payments ledger, feature switches (ads / sign-ups / payments / maintenance),
ban & premium controls, and the audit trail of everything you did.

> If you never set `ADMIN_*`, no admin exists and `/admin` will only ever show
> the login form. Set the two variables and restart the service to create one
> (it only ever bootstraps while the admin table is empty).

## 6. Payments (M-PESA)

Two modes, switched from **`/admin` → Settings** — nothing is hard-coded and
nothing needs a redeploy.

**Default: STK push (Daraja).** The lobby ships with an M-PESA panel driven
entirely by Settings (price, premium length, wording, and the Daraja
credentials). The buyer's phone prompts for the PIN and the callback settles
it — nothing for you to approve by hand. The money lands in your Paybill's
collection account, which you settle to your own M-PESA number on
Safaricom's side — no business bank account needed. The **Test connection**
button in Settings reports exactly which credential is still missing, and can
fire a real KES 1 prompt at a phone to prove the whole path works.

**Manual review mode.** No Daraja? Toggle **Manual payments** on in Settings
and set the destination buyers send to (e.g. a Pochi la Biashara number).
Every pay button then opens a pending charge and shows the buyer where to
send the money; you confirm the SMS in **Earnings → Charges** and approve it
in one tap. Approval takes the platform cut, credits the creator's wallet,
and unlocks whatever was bought — exactly as an STK sale would. Payouts work
the same: creators request in `/wallet`, you send the money by M-PESA and
approve in **Earnings → Payout requests**. Nothing is automatic, which is the
honest trade-off — use it until you have Daraja credentials.

Full walkthrough — including what to ask Safaricom for, and the Manual
review steps in detail — in [docs/PAYMENTS.md](docs/PAYMENTS.md).

## 7. Move existing accounts over (optional, 3 min)

If this PC's MariaDB already holds accounts people created, bring them along:

```bash
mariadb-dump --no-tablespaces --single-transaction matchup > matchup-dump.sql

mariadb --host AIVEN_HOST --port AIVEN_PORT --user avnadmin \
        --password 'AVN_PASSWORD' --ssl matchup < matchup-dump.sql
```

(The `--ssl` flag is for Aiven; drop it for a local target. Skip this section
entirely to start fresh — the schema re-creates itself.)

The Aiven free MySQL plan includes **1 GB of storage**. That is enough for a
long time because post media is stored in Vercel Blob, not in the database.
The admin **Database** card shows usage against `MARIADB_STORAGE_LIMIT_MB`
(default 1024). When you need more room, upgrade the Aiven plan in place (same
host and credentials), or move to a new service with `npm run db:copy` — see
[docs/SCALING.md](docs/SCALING.md) §6. Do not create a second database for the
same users; accounts, sessions, wallets and charges must stay in one primary.

## 8. Retire the PC stack (when you're ready)

Once the health check and a real call verify green, the site no longer needs
this computer. Keep the local MariaDB for development —
`scripts/local.sh start` brings the whole thing back any time.

---

## What it costs at scale

| Traffic | Setup | Monthly |
| --- | --- | --- |
| Free tiers (above) | Koyeb free instance + Aiven free | **$0** |
| Growth | **One VPS** (Hetzner/Contabo ~$5) runs the container + MariaDB, Caddy handles HTTPS | ~$5 |
| Real scale | Koyeb/Render paid instance + Aiven paid DB | $10–30 |

### Alternatives

- **Render** — `server/render.yaml` is a ready blueprint for the API-only
  mode. Its free instance sleeps after ~15 min idle; Koyeb is smoother.
- **Any VPS with Docker** — `docker build -t matchup . && docker run -p 4000:4000
  --env-file prod.env matchup` behind a Caddy/nginx TLS proxy. Everything in
  one place, full control.

### The invariants

- The server reads **all** configuration from environment variables — there is
  no `.env` in the image and no secret in the client bundle.
- Schema (accounts, passports, admins, payments, settings, audit) is created
  idempotently at boot; a missing database is created too.
- `GET /health` reports `store` / `accounts` so you can see which backend is
  live; `GET /api/config` reports the switches the dashboard controls.
- Local development is unchanged: `npm run dev` runs client + server on this
  PC against the local MariaDB.
