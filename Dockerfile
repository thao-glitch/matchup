# Matchup — standalone production image.
#
#   ONE container, ONE URL: the React app, the API and the WebSocket
#   signaling server all come out of a single `node server.js` process, so
#   there is no separate frontend host, no second service to keep in sync and
#   nothing to CORS-configure. The only other piece is the database.
#
#   docker build -t matchup .
#   docker run -p 4000:4000 --env-file prod.env matchup
#
# The image ships NO config: no .env, no database, no secrets. The platform
# (Koyeb, Render, a VPS) injects PORT, MARIADB_* and ADMIN_*.

# ── Stage 1: the client bundle ───────────────────────────────────────────────
FROM node:24-alpine AS client

WORKDIR /build

# Dependencies first: source edits then keep this layer cached.
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY client/ ./

# VITE_SIGNALING_URL is deliberately NOT set: an empty value makes the bundle
# call `/api`, `/api/ice` and `/socket.io` on its own origin — which is
# exactly what this image serves. One URL, no CORS, no rebuild to move hosts.
ENV VITE_SIGNALING_URL=
RUN npm run build

# ── Stage 2: server + bundle ─────────────────────────────────────────────────
FROM node:24-alpine

WORKDIR /app

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server/server.js ./
COPY server/src ./src

# server.js looks for `../client/dist` relative to itself → /app/client/dist.
COPY --from=client /build/dist ./client/dist

ENV NODE_ENV=production
EXPOSE 4000

# Alpine busybox wget: the same endpoint the platform probes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-4000}/health" || exit 1

CMD ["node", "server.js"]
