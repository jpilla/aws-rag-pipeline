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
COPY prisma ./prisma

# bring installed deps (incl. dev deps) from deps stage
COPY --from=deps /app/node_modules ./node_modules

# generate prisma client (no-op if prisma isn't present)
RUN [ -f prisma/schema.prisma ] && npx prisma generate || true

# compile TS
RUN npm run build

# remove dev deps from node_modules (we'll add prisma CLI in runtime)
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

# # Ensure prisma CLI is present for migrations even if it's in devDependencies
# # (install specific version if defined; otherwise 'latest')
# RUN PRISMA_VER=$(node -e "const p=require('./package.json'); const v=(p.dependencies&&p.dependencies.prisma)||(p.devDependencies&&p.devDependencies.prisma)||''; process.stdout.write(v||'latest')") \
#     && npm i --no-save prisma@${PRISMA_VER}

# Entry point: compose DATABASE_URL from ECS env, run migrations, start server
RUN printf '%s\n' \
    '#!/usr/bin/env sh' \
    'set -eu' \
    '' \
    '# fail fast if required envs missing' \
    'for k in DB_HOST DB_NAME DB_USER DB_PASSWORD; do' \
    '  eval "v=\${$k-}"; if [ -z "$v" ]; then echo "[entrypoint] Missing required env: $k" >&2; exit 1; fi' \
    'done' \
    '' \
    '# URL-encode with Node to handle special chars in credentials' \
    'encode() { node -e "process.stdout.write(encodeURIComponent(process.env[process.argv[1]]||\"\"))" "$1"; }' \
    'DBU=$(encode DB_USER)' \
    'DBP=$(encode DB_PASSWORD)' \
    '' \
    'export DATABASE_URL="postgresql://${DBU}:${DBP}@${DB_HOST}:5432/${DB_NAME}?sslmode=require"' \
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