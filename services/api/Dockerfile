# --- deps (install with lockfile) ---
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# --- build (compile + prisma generate) ---
FROM node:20-alpine AS build
WORKDIR /app
# Prisma engines need these on alpine during build
RUN apk add --no-cache openssl libc6-compat

COPY package*.json ./
COPY tsconfig.json ./
COPY src ./src
# include prisma schema so we can generate the client
COPY prisma ./prisma

# bring installed deps from deps stage
COPY --from=deps /app/node_modules ./node_modules

# generate prisma client (no-op if prisma isn't present)
RUN [ -f prisma/schema.prisma ] && npx prisma generate || true

# compile TS
RUN npm run build

# remove dev deps from node_modules
RUN npm prune --omit=dev

# --- runtime (ship only prod deps + compiled code) ---
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Prisma engines need these at runtime on alpine
RUN apk add --no-cache openssl libc6-compat

# minimal runtime payload
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma

# generic entrypoint: run prisma migrate, then start the server
# expects dist/db/prisma-start.js (your startup script) to exist in this service
# If you named it differently, adjust the path below.
RUN printf '%s\n' \
    '#!/usr/bin/env sh' \
    'set -eu' \
    'echo "[entrypoint] Running Prisma migrations…"' \
    'i=1' \
    'until npx prisma migrate deploy; do' \
    '  if [ "$i" -ge 10 ]; then echo "[entrypoint] prisma migrate failed after $i attempts"; exit 1; fi' \
    '  echo "[entrypoint] retry $i…"; i=$((i+1)); sleep 3;' \
    'done' \
    'echo "[entrypoint] Migrations complete. Starting API…"' \
    'exec node dist/server.js' \
    > /entrypoint.sh && chmod +x /entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]