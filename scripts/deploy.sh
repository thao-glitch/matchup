#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Matchup — one-command production deploy.
#
#   ./scripts/deploy.sh
#
# Builds the standalone image (client bundle + API + WebSocket server in ONE
# container), tags it, pushes it to Docker Hub, and — if Koyeb credentials are
# present — asks Koyeb to pull the new image and restart.
#
# Credentials come from `.deploy.env` in the repo root (never committed):
#
#   DOCKERHUB_USER=mauru2df
#   DOCKERHUB_TOKEN=dckr_pat_xxxxxxxx        # hub.docker.com → settings → security
#   DOCKERHUB_REPO=mauru2df/matchup          # the image name
#   KOYEB_TOKEN=                              # optional: app.koyeb.com → API tokens
#   KOYEB_APP_ID=                             # optional: speeds up the redeploy call
#
# Overrides via environment:  IMAGE=mytag ./scripts/deploy.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOCAL_TAG="${IMAGE:-matchup}"
TAG="${TAG:-latest}"

# ── Credentials ──────────────────────────────────────────────────────────────
if [ -f "$ROOT/.deploy.env" ]; then
  # shellcheck disable=SC1091
  set -a; . "$ROOT/.deploy.env"; set +a
fi

HUB="${DOCKERHUB_REPO:-}"
if [ -z "$HUB" ]; then
  echo "✗ DOCKERHUB_REPO is not set. Add it to .deploy.env (e.g. mauru2df/matchup)."
  exit 1
fi

ENGINE="docker"
command -v docker >/dev/null 2>&1 || { echo "✗ docker is not installed."; exit 1; }

# ── 1. Build ─────────────────────────────────────────────────────────────────
echo "── Building the standalone image ($LOCAL_TAG) — first run takes ~2 min"
"$ENGINE" build -t "$LOCAL_TAG" .
echo "✓ built $LOCAL_TAG"

# ── 2. Push ──────────────────────────────────────────────────────────────────
REMOTE="$HUB:$TAG"

if [ -n "${DOCKERHUB_TOKEN:-}" ]; then
  echo "── Logging in to docker.io as ${DOCKERHUB_USER:-?}"
  # A token is a password; pipe it in so it never lands in shell history/logs.
  printf '%s' "$DOCKERHUB_TOKEN" | "$ENGINE" login -u "${DOCKERHUB_USER:?set DOCKERHUB_USER}" --password-stdin
fi

echo "── Pushing $REMOTE"
"$ENGINE" tag "$LOCAL_TAG" "$REMOTE"
"$ENGINE" push "$REMOTE"
echo "✓ pushed $REMOTE"

# ── 3. Restart on Koyeb (optional) ───────────────────────────────────────────
if [ -n "${KOYEB_TOKEN:-}" ]; then
  if [ -n "${KOYEB_APP_ID:-}" ]; then
    echo "── Asking Koyeb to redeploy app $KOYEB_APP_ID"
    CODE=$(curl -s -o /tmp/koyeb-redeploy.json -w '%{http_code}' \
      -X PUT "https://app.koyeb.com/v1/apps/$KOYEB_APP_ID/redeploy" \
      -H "Authorization: Bearer $KOYEB_TOKEN" \
      -H 'Content-Type: application/json' -d '{}') || true
    if [ "$CODE" = "200" ] || [ "$CODE" = "202" ]; then
      echo "✓ redeploy requested ($CODE)"
    else
      echo "! Koyeb answered $CODE — see /tmp/koyeb-redeploy.json; redeploy from the dashboard."
    fi
  else
    echo "→ KOYEB_APP_ID not set: press ' redeploy' in the Koyeb dashboard to pick up $REMOTE."
  fi
else
  echo "→ KOYEB_TOKEN not set: redeploy from the Koyeb dashboard to pick up $REMOTE."
fi

echo
echo "Done. Verify:"
echo "  curl -s https://<your-app>.koyeb.app/health"
echo "  open  https://<your-app>.koyeb.app/admin"
