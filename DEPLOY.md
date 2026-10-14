# Running Matchup standalone (one container, one URL, no PC required)

Matchup ships as **a single container**: the React app, the API, the WebSocket
signaling server and the `/admin` dashboard all come out of one `node server.js`
process. There is no separate frontend host, nothing to keep in sync and no CORS
to configure — the browser talks to one origin for everything.

| Piece | Where | Cost |
| --- | --- | --- |
| **App + API + admin** (this repo, one image) | **Koyeb** — free web service | free |
| Database (accounts, passports, payments, settings) | **Aiven for MySQL** — free tier, no card | free |
| Image registry | **Docker Hub** — free | free |
| TURN relay (strict-NAT fallback) | **Cloudflare Realtime TURN** — free tier | free |

> Media itself is **peer-to-peer over WebRTC** — video never touches your
> server. The container only introduces people and relays a few KB of SDP/ICE.

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
   | `CORS_ORIGIN` | *optional* — only needed if you later serve the client from a second origin |
   | `CF_TURN_KEY_ID` / `CF_TURN_KEY_SECRET` | *optional* — step 4 |

4. Health check: **HTTP, path `/health`**. Deploy.

**Verify:**

```bash
curl -s https://<app>-<id>.koyeb.app/health
# {"status":"ok","store":"maria","accounts":"maria", …}
```

`store:maria` proves the database is live and the schema was created for you.

## 4. TURN relay — Cloudflare free tier (10 min, optional but recommended)

Without TURN, roughly one user in ten (symmetric NAT, CGNAT, strict corporate
Wi-Fi) hits "Unable to connect". Cloudflare issues short-lived relay credentials
with no infrastructure of your own:

1. **dash.cloudflare.com → Realtime → TURN → Create TURN key.**
2. Copy the key id + secret into Koyeb, redeploy.
3. Confirm: `curl -s https://<app>.koyeb.app/api/ice` reports
   `"source":"cloudflare"` and `"turnConfigured":true`.

*Leave it unset and the app still works STUN-only for ~90% of users.*

## 5. First admin login (2 min)

Open `https://<app>-<id>.koyeb.app/admin` and sign in with `ADMIN_USERNAME` /
`ADMIN_PASSWORD` from `.deploy.env`. From then on the dashboard owns its own
credentials — change the password in **Settings**, not in the environment.

The dashboard gives you: live users and queue, the call telemetry, the paybill
ledger, feature switches (ads / sign-ups / payments / maintenance), ban &
premium controls, and the audit trail of everything you did.

> If you never set `ADMIN_*`, no admin exists and `/admin` will only ever show
> the login form. Set the two variables and restart the service to create one
> (it only ever bootstraps while the admin table is empty).

## 6. Payments (paybill)

The lobby ships with a paybill panel driven entirely by
**`/admin` → Settings** (bank, paybill number, account-number format, price,
premium length, wording). Nothing is hard-coded and nothing needs a redeploy.

Full walkthrough — including exactly what to ask Diamond Trust Bank for —
in [docs/PAYMENTS.md](docs/PAYMENTS.md).

## 7. Move existing accounts over (optional, 3 min)

If this PC's MariaDB already holds accounts people created, bring them along:

```bash
mariadb-dump --no-tablespaces --single-transaction matchup > matchup-dump.sql

mariadb --host AIVEN_HOST --port AIVEN_PORT --user avnadmin \
        --password 'AVN_PASSWORD' matchup < matchup-dump.sql
```

(Add `--ssl` if the client refuses the connection. Skip it entirely to start
fresh — the schema re-creates itself.)

## 8. Retire the PC stack (when you're ready)

Once the health check and a real call verify green, the site no longer needs
this computer. Keep the local MariaDB for development —
`scripts/local.sh start` brings the whole thing back any time.

---

## What it costs at scale

| Traffic | Setup | Monthly |
| --- | --- | --- |
| Free tiers (above) | Koyeb free instance + Aiven free + Cloudflare free TURN | **$0** |
| Growth | **One VPS** (Hetzner/Contabo ~$5) runs the container + MariaDB + coturn, Caddy handles HTTPS | ~$5 |
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
