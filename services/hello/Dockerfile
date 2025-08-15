# --- deps (install with lockfile) ---
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# --- build (needs package.json for npm scripts) ---
FROM node:20-alpine AS build
WORKDIR /app
# bring in manifest + lockfile so `npm run build` & `npm prune` work
COPY package*.json ./
COPY tsconfig.json ./
COPY src ./src
# use the deps we installed in the previous stage (includes devDeps)
COPY --from=deps /app/node_modules ./node_modules
RUN npm run build
# drop devDependencies for runtime
RUN npm prune --omit=dev

# --- runtime (ship only prod deps + compiled code) ---
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# keep package.json (handy for `npm ls` and future tooling)
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 3001
CMD ["node", "dist/server.js"]