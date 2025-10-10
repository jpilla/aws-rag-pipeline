# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine

# --- deps ---
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ARG SERVICE_DIR
# bring in manifest first for caching
COPY ${SERVICE_DIR}/package*.json ./
RUN npm ci

# --- build ---
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ARG SERVICE_DIR
# need package.json here for "npm run build"
COPY --from=deps /app/package*.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY ${SERVICE_DIR}/tsconfig.json ./tsconfig.json
COPY ${SERVICE_DIR}/src ./src
RUN npm run build && npm prune --omit=dev

# --- runtime ---
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
USER node
# need package.json here for "npm run start"
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Copy source files for debugging source maps
COPY --from=build /app/src ./src
# EXPOSE is documentation; real port comes from $PORT + compose mapping
EXPOSE 3000
CMD ["npm", "run", "start"]