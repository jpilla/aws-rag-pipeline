# --- Build stage: compile TS ---
FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# --- Runtime: Lambda Node.js 20 base image ---
FROM public.ecr.aws/lambda/nodejs:20
WORKDIR /var/task

# Install prod deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled JS
COPY --from=build /app/dist ./

# Expose the handler symbol exported in dist/handler.js
CMD ["handler.handler"]