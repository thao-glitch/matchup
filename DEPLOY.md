# Running Matchup independently (no PC required)

The app is three pieces — client, signaling server, database. This guide moves
all of it into the cloud on **free tiers only: no credit card, no GitHub**.
After this, your computer can be off and the site keeps working.

| Piece | Where | Cost |
| --- | --- | --- |
| Client (React) | Vercel (already live: https://matchup-mu.vercel.app) | free |
| Signaling server (Node/Socket.io) | **Koyeb** — free web service, container image | free |
| Database (accounts + profiles) | **Aiven for MySQL** — free tier, no card | free |
| TURN relay (strict-NAT fallback) | **Cloudflare Realtime TURN** — free tier | free |

> Alternatives are at the end: Render (needs GitHub) and a paid VPS (full
> control, runs server + DB + coturn in one place, ~$5/mo).

---

## 1. Database — Aiven free MySQL (5 min)

1. Sign up at **https://aiven.io** (email or Google — *no credit card*).
2. **Create service → MySQL → Plan: Free → Create.** (The free tier picks the
   cloud/region for you; pick any project name.) Wait ~2 minutes.
3. Open the service → **Overview → Connection information** and copy:
   - **Host** (e.g. `mysql-xxxx.f.aivencloud.com`)
   - **Port** (a number like `12691`)
   - **User**: `avnadmin`
   - **Password**: click to reveal (or regenerate) — this is your
     `MARIADB_PASSWORD`.
4. The server creates its own database and tables on first boot
   (`MARIADB_DATABASE=matchup`), so there is nothing else to set up.

## 2. Push the server as a container image (5 min)

The server ships as a Docker/OCI image (`server/Dockerfile`). You need a free
Docker Hub account to host the built image: **https://hub.docker.com** → sign
up (email, no card). On this PC `podman` stands in for `docker` — the commands
are identical.

```bash
cd ~/Desktop/matchup
podman build --format docker -t matchup-server ./server     # ~1 min first time
podman login docker.io                                       # your Docker Hub login
podman tag  matchup-server docker.io/YOURHUBUSER/matchup-server:latest
podman push docker.io/YOURHUBUSER/matchup-server:latest      # ~30 s
```

> Every future deploy is those same four lines (build → tag → push), then
> restart the service on Koyeb.

## 3. Server — Koyeb free web service (10 min)

1. Sign up at **https://app.koyeb.com** (any sign-in method — no card).
2. **Create App → Web Service → Container image** and enter
   `docker.io/YOURHUBUSER/matchup-server:latest`.
3. Pick a **free** region (Frankfurt or Washington, D.C.).
4. Add the environment variables:

   | Key | Value |
   | --- | --- |
   | `CORS_ORIGIN` | `https://matchup-mu.vercel.app` |
   | `MARIADB_HOST` | from Aiven |
   | `MARIADB_PORT` | from Aiven |
   | `MARIADB_USER` | `avnadmin` |
   | `MARIADB_PASSWORD` | from Aiven |
   | `MARIADB_DATABASE` | `matchup` |
   | `MARIADB_SSL` | `true` |
   | `CF_TURN_KEY_ID` | *(optional — step 4)* |
   | `CF_TURN_KEY_SECRET` | *(optional — step 4)* |

5. Set the health check to **HTTP, path `/health`** and deploy. The service
   listens on the port Koyeb injects in `PORT` (the server reads it
   automatically) and binds `0.0.0.0` by default.
6. When the status is green, open `https://<app>-<id>.koyeb.app/health` — you
   want:

   ```json
   {"status":"ok", ..., "store":"maria", "accounts":"maria"}
   ```

   `store:maria` proves the Aiven database is live and the schema was created
   automatically.

## 4. TURN relay — Cloudflare free tier (10 min)

Without TURN, ~10% of users (symmetric NAT, CGNAT, strict Wi-Fi) hit
"Unable to connect". Cloudflare issues short-lived relay credentials with no
infrastructure of your own — no router config, no port-forward, no PC:

1. Sign up at **https://dash.cloudflare.com** (free plan, no card).
2. Left menu → **Realtime → TURN** → **Create TURN key**.
3. Copy the **key ID** and the **key secret** (the secret is shown once).
4. Set them on Koyeb as `CF_TURN_KEY_ID` / `CF_TURN_KEY_SECRET`, redeploy.
5. Verify: `https://<app>.koyeb.app/api/ice` must report
   `"source":"cloudflare"` and `"turnConfigured":true`.

*Leave these unset and the app still works — STUN-only — for ~90% of users.*

## 5. Point the client at the new server (2 min)

```bash
cd ~/Desktop/matchup/client
npx vercel env rm VITE_SIGNALING_URL production --yes
echo "https://<app>-<id>.koyeb.app" | npx vercel env add VITE_SIGNALING_URL production
npx vercel --prod
```

Or in the Vercel dashboard: Project → Settings → Environment Variables →
`VITE_SIGNALING_URL` → new value → redeploy.

**Verify everything end-to-end:**

```bash
APP_URL=https://matchup-mu.vercel.app API_URL=https://<app>-<id>.koyeb.app \
  node scripts/e2e.js          # expect 37/37, "account created from the lobby"
```

## 6. Move existing accounts over (optional, 3 min)

The PC's MariaDB may already hold accounts people created. Bring them along:

```bash
mariadb-dump --no-tablespaces --single-transaction matchup > matchup-dump.sql

mariadb --host AIVEN_HOST --port AIVEN_PORT --user avnadmin \
        --password 'AVN_PASSWORD' matchup < matchup-dump.sql
```

(If the client refuses the connection, add `--ssl`. Skip it entirely if you'd
rather start fresh — the server re-creates the schema itself.)

## 7. Retire the PC stack (when you're ready)

Once steps 1–5 verify green, the site no longer needs this computer:

```bash
systemctl --user disable --now matchup-tunnel matchup matchup-turn
```

Keep MariaDB installed locally if you want the old stack for development —
`scripts/local.sh start` brings the whole thing back any time.

---

## What each piece costs at scale

| Traffic | Setup | Monthly |
| --- | --- | --- |
| Free tiers (above) | — | **$0** (Koyeb free instance + Aiven free + Cloudflare free TURN) |
| Growth | **One VPS** (Hetzner/Contabo ~$5) runs server + MariaDB + coturn with `docker compose`, Caddy handles HTTPS | ~$5 |
| Real scale | Koyeb/Render paid instance + Aiven paid DB | $10–30 |

### Alternative: Render (needs a GitHub repo)

`server/render.yaml` is a ready blueprint (web service, `npm install` /
`npm start`, health check `/health`). GitHub-connect the repo → New →
Blueprint. Set the same env vars as step 3. Caveat: Render's free instance
**sleeps after ~15 min of no traffic** (first visitor waits ~50 s; clients
reconnect automatically) — Koyeb's free instance is the smoother path.

### The invariants

- The server reads **all** configuration from environment variables — there is
  no `.env` in the image and no secret in the client bundle.
- Schema is created idempotently at boot; a missing database is created too.
- `GET /health` reports `store`/`accounts` so you can see which backend is live.
- Local development is unchanged: `scripts/local.sh start` runs everything on
  this PC with the local MariaDB.
