# Matchup signaling server — one small image, configured entirely by env vars.
#
#   podman build -t matchup-server ./server      (plain docker works too)
#   podman run -p 4000:4000 --env-file prod.env matchup-server
#
# The image ships NO config: no .env, no database, no secrets. The platform
# (Koyeb, Render, a VPS) injects PORT, CORS_ORIGIN and MARIADB_*.
FROM node:24-alpine

WORKDIR /app

# Dependencies first: source edits then keep this layer cached.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 4000

# Alpine busybox wget: the same endpoint the platform probes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-4000}/health" || exit 1

CMD ["node", "server.js"]
