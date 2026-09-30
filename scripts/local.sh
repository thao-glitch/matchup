#!/usr/bin/env bash
#
# Matchup — local stack control (signaling server + public tunnel).
#
#   scripts/local.sh start [--sync-vercel]   start/repair everything, print URLs
#   scripts/local.sh sync                    push a changed tunnel URL to Vercel
#   scripts/local.sh stop                    stop the server and the tunnel
#   scripts/local.sh status                  what is running, and is it healthy?
#
# A quick tunnel hands out a NEW url on every start (reboots included), and the
# deployed client bakes its URL in at build time — so whenever that happens,
# `sync` pushes the new address into Vercel (VITE_SIGNALING_URL) and redeploys.
# matchup-tunnel.service runs it after every start, so boots self-heal; run it
# by hand (`local.sh sync`) only if a deploy failed.
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO="$PWD"
URL_FILE="$REPO/.tunnel-url"
SERVER_UNIT=matchup
TUNNEL_UNIT=matchup-tunnel
TURN_UNIT=matchup-turn
SYNC=0
ACTION=start
for a in "$@"; do
  case "$a" in
    --sync-vercel) SYNC=1 ;;
    start|sync|stop|status) ACTION="$a" ;;
    *) echo "usage: $0 start [--sync-vercel] | sync | stop | status"; exit 2 ;;
  esac
done

have_um() { systemctl --user status >/dev/null 2>&1; }
port_holder() { lsof -tiTCP:4000 -sTCP:LISTEN 2>/dev/null || true; }
unit_active() { systemctl --user is-active --quiet "$1" 2>/dev/null; }

# Append a breadcrumb to .sync.log. ExecStartPost output sometimes vanishes
# into the journal, and `set -e` aborts print nothing — this file is the
# breadcrumb trail that shows which step a background sync died on.
# Writes are best-effort: a failing log must never take the script down.
slog() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" >>"$REPO/.sync.log" 2>/dev/null || true; }

tunnel_url() { # newest quick-tunnel URL from the unit journal
  journalctl --user -u "$TUNNEL_UNIT" -n 300 --no-pager 2>/dev/null |
    grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1
}

wait_url() { # URL minted by the CURRENT unit run (quick tunnels print it in
  # a few seconds). Only looks at lines written since this run's main process
  # started, because the journal still holds the previous run's URL — pushing
  # that one to Vercel is exactly the bug that leaves the site pointing at a
  # dead host.
  # NB: `set -e` + `pipefail` are on — grep finding nothing must not abort us.
  # This systemd has no ...USec timestamp properties, so parse the human one.
  local ts epoch u
  ts="$(systemctl --user show "$TUNNEL_UNIT" -p ExecMainStartTimestamp --value 2>/dev/null || true)"
  epoch=0
  if [ -n "$ts" ]; then
    epoch="$(date -d "${ts% [A-Z]*}" +%s 2>/dev/null || echo 0)"
    case "$epoch" in '' | *[!0-9]*) epoch=0 ;; esac
  fi
  for _ in $(seq 1 60); do
    u="$(journalctl --user -u "$TUNNEL_UNIT" --since "@$epoch" --no-pager 2>/dev/null |
      grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)"
    if [ -n "$u" ]; then echo "$u"; return 0; fi
    sleep 1
  done
  return 1
}

health() { curl -s --max-time 3 "$1" 2>/dev/null || true; }

sync_vercel() {
  local url="$1"
  if ! command -v npx >/dev/null 2>&1; then
    echo "✗ npx not on PATH — cannot reach the Vercel CLI from here"
    return 1
  fi
  echo "  → updating Vercel env VITE_SIGNALING_URL = $url"
  ( cd client || exit 1
    npx --yes vercel env rm VITE_SIGNALING_URL production --yes >/dev/null 2>&1 || true
    # If the env push fails (expired auth, offline), stop: deploying now would
    # bake the OLD url into the fresh bundle and hide the mismatch.
    echo "$url" | npx --yes vercel env add VITE_SIGNALING_URL production >/dev/null || exit 1
    npx --yes vercel --prod >/dev/null || exit 1
    echo "  → client redeployed with the new URL" )
}

# Push the live tunnel URL to Vercel *only if it changed*, then record it in
# `.tunnel-url` (which therefore always means "what the deployed client uses").
# Called by `start --sync-vercel`, by `local.sh sync`, and automatically by
# matchup-tunnel.service after every start — a quick tunnel hands out a NEW url
# on every start, and reboots used to leave the site pointing at a dead host.
sync_if_changed() {
  local url="${1:-}" prev
  # `start --sync-vercel` and the unit's ExecStartPost can land seconds apart:
  # one deploy at a time, the second one then finds nothing to do.
  exec 9>"$REPO/.sync.lock"
  slog "lock: acquiring"
  flock 9
  slog "lock: held"
  if [ -z "$url" ]; then
    url="$(wait_url || true)"
  fi
  if [ -z "$url" ]; then
    echo "✗ no tunnel URL from this run — not syncing"
    slog "url: none found"
    return 1
  fi
  prev="$(cat "$URL_FILE" 2>/dev/null || true)"
  slog "url=[$url] prev=[$prev]"
  if [ "$url" = "$prev" ]; then
    echo "✓ tunnel URL unchanged — deployed client already points at $url"
    return 0
  fi
  echo "! tunnel URL changed${prev:+ (was $prev)}"
  slog "deploying $url"
  sync_vercel "$url" || {
    echo "✗ Vercel sync failed — .tunnel-url left as ${prev:-'never'} so status shows the mismatch"
    slog "deploy FAILED"
    return 1
  }
  echo "$url" > "$URL_FILE"
  echo "✓ .tunnel-url → $url"
  slog "deploy ok → $url"
}

case "$ACTION" in
  start)
    if ! have_um; then
      echo "✗ no systemd user manager — start manually:  (cd server && npm start)"
      exit 1
    fi
    systemctl --user daemon-reload

    if ! systemctl is-active --quiet mariadb; then
      echo "! MariaDB is not running — the app would fall back to memory mode."
      echo "  Run:  sudo systemctl start mariadb"
    fi

    # Adopt anything started by hand so the units can bind their ports.
    if ! unit_active "$SERVER_UNIT"; then
      pids="$(port_holder)"
      if [ -n "$pids" ]; then
        echo "  stopping stray server on :4000 (pid $pids) — systemd owns it now"
        kill $pids 2>/dev/null || true; sleep 1
      fi
    fi
    if ! unit_active "$TUNNEL_UNIT" && pgrep -x cloudflared >/dev/null 2>&1; then
      echo "  stopping stray cloudflared — systemd owns it now"
      pkill -x cloudflared 2>/dev/null || true; sleep 1
    fi

    echo "  starting $SERVER_UNIT + $TURN_UNIT"
    systemctl --user start "$SERVER_UNIT"
    systemctl --user start "$TURN_UNIT"

    echo -n "  waiting for the server"
    H=""
    for _ in $(seq 1 30); do H="$(health http://localhost:4000/health)"; [ -n "$H" ] && break; echo -n "."; sleep 1; done
    echo
    if [ -z "$H" ]; then
      echo "✗ server is not answering on :4000"
      systemctl --user status "$SERVER_UNIT" --no-pager -n 20
      exit 1
    fi
    echo "✓ server healthy: $(echo "$H" | grep -o '"store":"[a-z]*"')"

    if [ "$(podman inspect matchup-turn --format '{{.State.Running}}' 2>/dev/null)" = "true" ]; then
      echo "✓ coturn relay running (udp+tcp 3478 — the fallback for strict-NAT users)"
    else
      echo "! coturn relay is NOT running — the app falls back to STUN-only"
      systemctl --user status "$TURN_UNIT" --no-pager -n 20 || true
    fi

    if unit_active "$TUNNEL_UNIT"; then
      # Already up: keep its URL. Restarting would mint a new one for no reason
      # and force another Vercel redeploy.
      URL="$(tunnel_url || true)"
      if [ -n "$URL" ]; then echo "✓ tunnel already running: $URL"; fi
    else
      # The journal still holds the PREVIOUS run's URL — remember it so we only
      # accept one minted by *this* start.
      OLD_URL="$(tunnel_url || true)"
      echo "  starting $TUNNEL_UNIT"
      systemctl --user start "$TUNNEL_UNIT"
      echo -n "  waiting for a fresh tunnel URL"
      URL=""
      for _ in $(seq 1 30); do
        URL="$(tunnel_url || true)"
        if [ -n "$URL" ] && [ "$URL" != "$OLD_URL" ]; then break; fi
        URL=""; echo -n "."; sleep 1
      done
      echo
    fi
    if [ -z "$URL" ]; then
      echo "✗ tunnel produced no URL"
      systemctl --user status "$TUNNEL_UNIT" --no-pager -n 30
      exit 1
    fi
    echo "✓ tunnel: $URL"

    # `systemctl start` above also ran the unit's ExecStartPost (local.sh sync),
    # so this is belt-and-braces: it covers the "tunnel was already running"
    # branch, where systemd never re-runs ExecStartPost.
    if [ "$SYNC" = "1" ]; then
      sync_if_changed "$URL"
    else
      PREV="$(cat "$URL_FILE" 2>/dev/null || true)"
      if [ "$URL" != "$PREV" ]; then
        echo "! tunnel URL changed${PREV:+ (was $PREV)}"
        echo "  The deployed client still bakes in the old one. Resync with:"
        echo "      scripts/local.sh sync        (or: scripts/local.sh start --sync-vercel)"
        echo "  (skipped — no --sync-vercel)"
      fi
    fi
    echo
    echo "local:  http://localhost:4000      public: $URL      site: https://matchup-mu.vercel.app"
    ;;

  stop)
    if have_um; then
      systemctl --user stop "$TUNNEL_UNIT" 2>/dev/null || true
      systemctl --user stop "$TURN_UNIT" 2>/dev/null || true
      systemctl --user stop "$SERVER_UNIT" 2>/dev/null || true
    fi
    pids="$(port_holder)"; [ -n "$pids" ] && { echo "  killed stray server $pids"; kill $pids 2>/dev/null || true; }
    # -x matches the process *name* exactly — never a shell whose command line
    # merely mentions cloudflared (pkill -f would kill this script's own caller).
    pkill -x cloudflared 2>/dev/null || true
    echo "✓ stopped (MariaDB left running — it owns your data)"
    ;;

  status)
    # is-active/is-enabled print the state but also exit non-zero for
    # inactive/disabled — capture stdout only, or the word appears twice.
    if have_um; then
      sa="$(systemctl --user is-active  "$SERVER_UNIT" 2>/dev/null || true)"
      se="$(systemctl --user is-enabled "$SERVER_UNIT" 2>/dev/null || true)"
      ta="$(systemctl --user is-active  "$TUNNEL_UNIT" 2>/dev/null || true)"
      te="$(systemctl --user is-enabled "$TUNNEL_UNIT" 2>/dev/null || true)"
      ra="$(systemctl --user is-active  "$TURN_UNIT" 2>/dev/null || true)"
      re="$(systemctl --user is-enabled "$TURN_UNIT" 2>/dev/null || true)"
      printf "server : %-10s %s\n" "${sa:-?}" "${se:-?}"
      printf "tunnel : %-10s %s\n" "${ta:-?}" "${te:-?}"
      printf "turn   : %-10s %s\n" "${ra:-?}" "${re:-?}"
    fi
    ma="$(systemctl is-active  mariadb 2>/dev/null || true)"
    me="$(systemctl is-enabled mariadb 2>/dev/null || true)"
    printf "mariadb: %-10s %s\n" "${ma:-?}" "${me:-?}"
    echo "health : $(health http://localhost:4000/health | head -c 200)"
    echo "tunnel : $(tunnel_url || echo 'not running')"
    echo "synced : $(cat "$URL_FILE" 2>/dev/null || echo 'never')"
    ;;

  sync)
    # Push the live tunnel URL to Vercel if it changed. Wired into
    # matchup-tunnel.service as ExecStartPost, so a reboot self-heals: quick
    # tunnels mint a NEW url on every start, and until this runs the deployed
    # client still points at the dead one — which breaks every API call,
    # account creation included.
    #
    # NB: `activating` counts — this action IS the ExecStartPost, so the unit
    # is mid-start whenever systemd runs it.
    state="$(systemctl --user is-active "$TUNNEL_UNIT" 2>/dev/null || true)"
    slog "sync: state=[$state]"
    case "$state" in
      active* | activating*) ;;
      *)
        slog "sync: guard rejected"
        echo "✗ tunnel is not running — start it first: scripts/local.sh start --sync-vercel"
        exit 1
        ;;
    esac
    rc=0
    sync_if_changed || rc=$?
    slog "sync: finished rc=$rc"
    [ "$rc" -eq 0 ] || exit "$rc"
    ;;

  *) echo "usage: $0 start [--sync-vercel] | sync | stop | status"; exit 2 ;;
esac
