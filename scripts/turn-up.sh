#!/usr/bin/env bash
#
# Matchup — (re)create the coturn container so it works as a *public* relay.
#
#   scripts/turn-up.sh              # idempotent: no-op when the config matches
#   TURN_PUBLIC_IP=1.2.3.4 scripts/turn-up.sh   # pin the addresses (overrides)
#
# What it sets beyond a dev coturn, and why:
#
#   --external-ip=<public>/<private>  without it coturn advertises 192.168.x as
#                                     the relay address, which remote peers
#                                     cannot reach — the relay silently never
#                                     gets used.
#   --min-port/--max-port (49152-49408)
#                                     a narrow, forwardable range instead of
#                                     the default 49152-65535 (16k ports).
#   --restart unless-stopped          survives a container crash
#   --no-cli/--no-multicast-peers     don't expose the telnet CLI or multicast
#
# The public address is auto-detected on every run, so a changed ISP IP is
# picked up the next time this script recreates the container.
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME=matchup-turn
IMAGE=docker.io/coturn/coturn:latest

# One source of truth: the same secret the app signs credentials with.
SECRET="$(grep -E '^TURN_SECRET=' "$REPO/server/.env" 2>/dev/null | cut -d= -f2- || true)"
SECRET="${SECRET:-matchupdevsecret}"

PRIV="${TURN_PRIVATE_IP:-$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')}"
PUB="${TURN_PUBLIC_IP:-}"
if [ -z "$PUB" ]; then
  PUB="$(curl -4 -s --max-time 8 https://ifconfig.me 2>/dev/null || true)"
fi
if [ -z "$PUB" ]; then
  PUB="$(curl -4 -s --max-time 8 https://api.ipify.org 2>/dev/null || true)"
fi

MIN_PORT="${TURN_MIN_PORT:-49152}"
MAX_PORT="${TURN_MAX_PORT:-49408}"

if [ -z "$PRIV" ] || [ -z "$PUB" ]; then
  echo "✗ could not detect addresses (private='$PRIV' public='$PUB')." >&2
  echo "  Set them explicitly: TURN_PUBLIC_IP=… TURN_PRIVATE_IP=… $0" >&2
  exit 1
fi

# ── keep server/.env pointing at this machine ────────────────────────────────
# The container's external-ip is only half the job: the URL list the browsers
# are handed lives in .env. Rewriting it here is what makes "an ISP address
# change" a one-command fix. Guarded so a hostname (VPS/Twilio setups) is never
# silently replaced — only the IP-address form this script owns.
ENV="$REPO/server/.env"
NEEDS_RESTART=0
if [ -f "$ENV" ]; then
  sync_urls() { # $1 = var name, $2 = new value
    local cur
    cur="$(grep -E "^$1=" "$ENV" | cut -d= -f2- || true)"
    [ -z "$cur" ] && return 0
    if [[ ! "$cur" =~ ^turn:[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+: ]]; then
      echo "· $1 left alone (not an IP-address list): $cur"
      return 0
    fi
    if [ "$cur" != "$2" ]; then
      sed -i "s|^$1=.*|$1=$2|" "$ENV"
      echo "→ $1 updated in server/.env → $2"
      NEEDS_RESTART=1
    fi
  }
  sync_urls TURN_URLS       "turn:$PUB:3478?transport=udp,turn:$PUB:3478?transport=tcp"
  sync_urls TURN_URLS_LOCAL "turn:$PRIV:3478?transport=udp,turn:127.0.0.1:3478?transport=udp"
fi

# The server reads .env at boot only — say so loudly when we changed it.
hint_restart() {
  [ "$NEEDS_RESTART" = "1" ] &&
    echo "! relay address changed in server/.env → apply it:  systemctl --user restart matchup"
  return 0
}

ARGS=(
  -n -v --log-file=stdout --fingerprint
  --use-auth-secret "--static-auth-secret=$SECRET"
  --realm=matchup.test
  --listening-port=3478
  "--min-port=$MIN_PORT" "--max-port=$MAX_PORT"
  "--external-ip=$PUB/$PRIV"
  --allow-loopback-peers # local E2E relay tests dial 127.0.0.1
  --no-cli
  --no-multicast-peers
  --total-quota=40        # cap concurrent relays — this is a home uplink
)

want="$(printf '%s\n' "${ARGS[@]}")"
have="$(podman inspect "$NAME" --format '{{json .Config.Cmd}}' 2>/dev/null |
  python3 -c 'import json,sys
try:
    print("\n".join(json.load(sys.stdin)))
except Exception:
    pass' || true)"

if [ -n "$have" ] && [ "$have" = "$want" ]; then
  if [ "$(podman inspect "$NAME" --format '{{.State.Running}}' 2>/dev/null)" = "true" ]; then
    echo "✓ coturn already running with this config (external-ip=$PUB/$PRIV)"
  else
    podman start "$NAME" >/dev/null
    echo "✓ coturn started — config unchanged (external-ip=$PUB/$PRIV)"
  fi
  hint_restart
  exit 0
fi

echo "→ recreating $NAME"
echo "    external-ip = $PUB/$PRIV"
echo "    relay ports = udp+tcp 3478, udp $MIN_PORT-$MAX_PORT"

podman rm -f "$NAME" >/dev/null 2>&1 || true
podman run -d --name "$NAME" --network host --restart unless-stopped \
  "$IMAGE" "${ARGS[@]}" >/dev/null

sleep 1.5
if [ "$(podman inspect "$NAME" --format '{{.State.Running}}' 2>/dev/null)" != "true" ]; then
  echo "✗ container did not stay up:" >&2
  podman logs --tail 20 "$NAME" >&2 || true
  exit 1
fi
echo "✓ coturn up (udp+tcp 3478, relay udp $MIN_PORT-$MAX_PORT, quota 40)"
