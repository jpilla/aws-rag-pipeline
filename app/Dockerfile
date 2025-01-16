# Base stage for dependencies and build
FROM node:23.4.0-alpine AS base
WORKDIR /usr/src/app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy application files and tsconfig for TypeScript compilation
COPY ./src ./src
COPY tsconfig.json ./

# Compile TypeScript
RUN npx tsc

# Production stage
FROM node:23.4.0-alpine AS prod
WORKDIR /usr/src/app

# Copy compiled JavaScript and dependencies
COPY --from=base /usr/src/app/dist /usr/src/app/dist
COPY --from=base /usr/src/app/src /usr/src/app/src
COPY --from=base /usr/src/app/package*.json /usr/src/app/

# Verify files in the production image
RUN ls -la /usr/src/app

# Install only production dependencies
RUN npm install --only=production

EXPOSE 3000

# Start the application
CMD ["sh", "-c", "node dist/index.js"]

# Development stage (for debugging with ts-node)
FROM base AS dev
WORKDIR /usr/src/app

# Install ts-node globally for debugging
# RUN npm install -g ts-node
RUN npm install --only=development

EXPOSE 3000 9229
CMD ["node", "--inspect-brk=0.0.0.0:9229", "-r", "ts-node/register", "src/index.ts"]