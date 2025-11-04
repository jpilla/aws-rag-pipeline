# --- deps (install with lockfile) ---
FROM node:20-alpine AS deps
WORKDIR /app

# Copy shared-prisma first and build it (needed for file: dependency)
COPY lib/shared-prisma/package*.json ./lib/shared-prisma/
COPY lib/shared-prisma/tsconfig.json ./lib/shared-prisma/
COPY lib/shared-prisma/src ./lib/shared-prisma/src

# Install shared-prisma dependencies and build it
WORKDIR /app/lib/shared-prisma
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi && npm run build

# Now install API dependencies
WORKDIR /app
COPY services/api/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# --- build (compile + prisma generate) ---
FROM node:20-alpine AS build
WORKDIR /app

# Optionally run tests during the build stage (default: true)
ARG RUN_TESTS=true
# Ensure readable, colorized logs in non-TTY Docker builds
ENV FORCE_COLOR=1
ENV TERM=xterm-256color

# Prisma engines need these on alpine during build
RUN apk add --no-cache openssl libc6-compat

COPY services/api/package*.json ./
COPY services/api/tsconfig.json ./
COPY services/api/jest.config.js ./
COPY services/api/src ./src
COPY services/api/tests ./tests
COPY prisma/schema.prisma ./prisma/schema.prisma
COPY prisma/migrations/ ./prisma/migrations/
COPY lib/shared-prisma/ ./lib/shared-prisma/

# bring installed deps (incl. dev deps) from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Build shared-prisma first (needed for TypeScript compilation)
RUN cd lib/shared-prisma && npm install && npm run build

# generate prisma client (no-op if prisma isn't present)
RUN [ -f prisma/schema.prisma ] && npx prisma generate || true

# compile TS (tsc-alias will rewrite path aliases after compilation)
RUN npm run build

# optionally run unit tests inside the image build; fails the build on test failure
RUN if [ "$RUN_TESTS" = "true" ]; then \
  printf '\n[build] ==================== Running Shared-Prisma Tests ====================\n\n'; \
  cd lib/shared-prisma && NODE_PATH=/app/node_modules /app/node_modules/.bin/jest --runInBand --verbose --colors || exit 1; \
  cd /app && \
  printf '\n[build] ==================== Running API Unit Tests ====================\n\n'; \
  npm run test -- --runInBand --verbose --colors; \
  else echo "[build] Skipping unit tests (RUN_TESTS=$RUN_TESTS)"; fi

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
COPY --from=build /app/lib/shared-prisma ./lib/shared-prisma
COPY --from=build /app/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=build /app/prisma/migrations/ ./prisma/migrations/

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
    '# Use DB_SSLMODE if set, otherwise default to require for production' \
    'SSL_MODE="${DB_SSLMODE:-require}"' \
    'export DATABASE_URL="postgresql://${DBU}:${DBP}@${DB_HOST}:5432/${DB_NAME}?sslmode=${SSL_MODE}"' \
    'echo "[entrypoint] Running Prisma migrations…"' \
    'i=1' \
    'until npx prisma migrate deploy; do' \
    '  if [ "$i" -ge 3 ]; then echo "[entrypoint] prisma migrate failed after $i attempts"; exit 1; fi' \
    '  echo "[entrypoint] retry $i…"; i=$((i+1)); sleep 3;' \
    'done' \
    'echo "[entrypoint] Migrations complete. Starting API…"' \
    'exec node dist/server.js' \
    > /entrypoint.sh && chmod +x /entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
