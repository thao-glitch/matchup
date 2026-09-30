#!/usr/bin/env bash
#
# Matchup — deployed-URL watchdog.
#
# The signaling server lives behind a Cloudflare *quick tunnel*, which mints a
# NEW url on every restart. The URL is baked into the Vercel bundle at build
# time, so whenever a sync is missed the public site silently points at a dead
# host and every visitor sees "cannot reach server".
#
# matchup-tunnel.service already runs `local.sh sync` after each start, but its
# ExecStartPost is allowed to fail quietly (it must never take the tunnel down)
# — so this timer independently verifies the END result: what the *deployed
# bundle* actually contains, compared with the tunnel that is alive right now.
#
#   scripts/watchdog.sh          # exit 0 = fine (or fixed), exit 1 = needs eyes
#
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
REPO="$PWD"
SITE="${SITE_URL:-https://matchup-mu.vercel.app}"
TUNNEL_UNIT="${TUNNEL_UNIT:-matchup-tunnel}"

say() { printf '%s %s\n' "$(date '+%b %d %H:%M:%S')" "$*"; }

# ── 1. Which tunnel URL is alive right now? ──────────────────────────────────
live="$(journalctl --user -u "$TUNNEL_UNIT" -n 300 --no-pager 2>/dev/null |
  grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)"
if [ -z "$live" ]; then
  say "✗ tunnel printed no URL — not touching Vercel (deploying would bake in nothing)"
  exit 1
fi

# The tunnel process can be "active" while its edge URL is already dead, so ask
# the origin itself rather than trusting the unit state.
if ! curl -fsS --max-time 12 "$live/health" >/dev/null 2>&1; then
  say "! tunnel $live is not answering /health — will retry next tick"
  exit 1
fi

# ── 2. What does the LIVE site actually point at? ───────────────────────────
bundle="$(curl -fsS --max-time 20 "$SITE/" 2>/dev/null |
  grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1 || true)"
if [ -z "$bundle" ]; then
  say "! could not read $SITE — will retry next tick"
  exit 1
fi
baked="$(curl -fsS --max-time 20 "$SITE$bundle" 2>/dev/null |
  grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1 || true)"

# No tunnel URL in the bundle means the client is aimed at a PERMANENT signaling
# host (the Koyeb migration) — that is the desired end state, and re-pushing the
# tunnel URL now would undo it. Stand down instead of "fixing" it.
if [ -z "$baked" ]; then
  say "✓ site uses a permanent signaling host — tunnel watchdog idle"
  exit 0
fi

# ── 3. Drift? Repush + redeploy, then leave .tunnel-url as the receipt ──────
if [ "$baked" = "$live" ]; then
  say "✓ ok — site points at $live"
  exit 0
fi

say "! drift: site=$baked live=$live — resyncing"
if "$REPO/scripts/local.sh" sync; then
  say "✓ resynced"
  exit 0
fi
say "✗ resync failed — check .sync.log and Vercel auth (npx vercel whoami)"
exit 1
