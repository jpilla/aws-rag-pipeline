# --- deps (install with lockfile) ---
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# --- build (needs package.json for npm scripts) ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY tsconfig.json ./
COPY src ./src
COPY --from=deps /app/node_modules ./node_modules
RUN npm run build
RUN npm prune --omit=dev

# --- runtime (ship only prod deps + compiled code) ---
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/server.js"]