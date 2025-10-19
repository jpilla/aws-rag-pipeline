# --- Build stage: compile TS ---
FROM node:20-alpine AS build
WORKDIR /app

COPY lambdas/ingest-queue-reader/package*.json ./
RUN npm ci

COPY lambdas/ingest-queue-reader/tsconfig.json ./
COPY lambdas/ingest-queue-reader/src ./src
COPY prisma/schema.prisma ./prisma/schema.prisma

RUN npm run build

# --- Runtime: Lambda Node.js 20 base image ---
FROM public.ecr.aws/lambda/nodejs:20
WORKDIR /var/task

# Install prod deps
COPY lambdas/ingest-queue-reader/package*.json ./
RUN npm ci --omit=dev

# Copy compiled JS
COPY --from=build /app/dist ./

# Expose the handler symbol exported in dist/handler.js
CMD ["handler.handler"]