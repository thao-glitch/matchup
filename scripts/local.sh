#!/usr/bin/env bash
#
# Matchup — local stack control (signaling server).
#
#   scripts/local.sh start    start/repair everything, print URLs
#   scripts/local.sh stop     stop the server (MariaDB is left running)
#   scripts/local.sh status   what is running, and is it healthy?
#
# The public half of this stack has been removed on purpose: the Cloudflare
# quick tunnel, the `sync` that pushed its rotating address into Vercel, and
# the watchdog that verified the result are all gone, because a URL that
# changes on every restart can never satisfy "the deployed app just runs".
# The machine now serves the API on localhost only.
#
# To put a public API behind the deployed client again, set
# `VITE_SIGNALING_URL` in Vercel to a *permanent* https host and redeploy —
# nothing in this script needs to run for that, and the client will pick it
# up on the next build.
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO="$PWD"
SERVER_UNIT=matchup
ACTION=start
case "${1:-start}" in
  start | stop | status) ACTION=$1 ;;
  *) echo "usage: $0 start | stop | status"; exit 2 ;;
esac

have_um() { systemctl --user status >/dev/null 2>&1; }
port_holder() { lsof -tiTCP:4000 -sTCP:LISTEN 2>/dev/null || true; }
unit_active() { systemctl --user is-active --quiet "$1" 2>/dev/null; }
health() { curl -s --max-time 3 "http://localhost:4000/health" 2>/dev/null || true; }

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

  # Adopt anything started by hand so the unit can bind its port.
  if ! unit_active "$SERVER_UNIT"; then
    pids="$(port_holder)"
    if [ -n "$pids" ]; then
      echo "  stopping stray server on :4000 (pid $pids) — systemd owns it now"
      kill $pids 2>/dev/null || true; sleep 1
    fi
  fi

  echo "  starting $SERVER_UNIT"
  systemctl --user start "$SERVER_UNIT"

  echo -n "  waiting for the server"
  H=""
  for _ in $(seq 1 30); do H="$(health)"; [ -n "$H" ] && break; echo -n "."; sleep 1; done
  echo
  if [ -z "$H" ]; then
    echo "✗ server is not answering on :4000"
    systemctl --user status "$SERVER_UNIT" --no-pager -n 20
    exit 1
  fi
  echo "✓ server healthy: $(echo "$H" | grep -o '"store":"[a-z]*"')"
  echo
  echo "local:  http://localhost:4000"
  echo "note:   localhost only — the deployed client has no API host set (see header)"
  ;;

stop)
  if have_um; then
    systemctl --user stop "$SERVER_UNIT" 2>/dev/null || true
  fi
  pids="$(port_holder)"; [ -n "$pids" ] && { echo "  killed stray server $pids"; kill $pids 2>/dev/null || true; }
  echo "✓ stopped (MariaDB left running — it owns your data)"
  ;;

status)
  if have_um; then
    sa="$(systemctl --user is-active "$SERVER_UNIT" 2>/dev/null || true)"
    se="$(systemctl --user is-enabled "$SERVER_UNIT" 2>/dev/null || true)"
    printf 'server : %-10s %s\n' "${sa:-?}" "${se:-?}"
  fi
  ma="$(systemctl is-active mariadb 2>/dev/null || true)"
  me="$(systemctl is-enabled mariadb 2>/dev/null || true)"
  printf 'mariadb: %-10s %s\n' "${ma:-?}" "${me:-?}"
  echo "health : $(health | head -c 200)"
  echo "public : none configured (VITE_SIGNALING_URL unset in Vercel)"
  ;;

esac
