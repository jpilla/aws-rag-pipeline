#!/usr/bin/env bash
# Debug Lambda locally with real database connection via bastion tunnel
# Usage: ./scripts/debug-lambda-local.sh [--no-build] [--no-tunnel]

set -euo pipefail

NO_BUILD=false
NO_TUNNEL=false

# Parse flags
while [[ $# -gt 0 ]]; do
  case $1 in
    --no-build)
      NO_BUILD=true
      shift
      ;;
    --no-tunnel)
      NO_TUNNEL=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--no-build] [--no-tunnel]"
      exit 1
      ;;
  esac
done

echo "🐛 Setting up Lambda local debugging with real database..."

# Source shared utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/aws-config.sh"

# Check prerequisites
check_prerequisites

# Setup local environment (this will set all the AWS/CDK config)
# We need to handle the tunnel flag specially since setup-local-env.sh expects it as --no-tunnel
if [ "$NO_TUNNEL" = true ]; then
  source "${SCRIPT_DIR}/setup-local-env.sh" --no-tunnel --no-db-creds
else
  source "${SCRIPT_DIR}/setup-local-env.sh" --no-db-creds
fi

# Build Docker image if not skipped
if [ "$NO_BUILD" = false ]; then
  echo ""
  echo "🐳 Building Lambda Docker image..."
  cd lambdas/ingest-queue-reader
  npm ci >/dev/null 2>&1 || echo "⚠️  npm ci failed, continuing..."
  npm run build
  cd - >/dev/null

  docker build -f lambdas/ingest-queue-reader/Dockerfile \
    -t ingest-queue-reader:local \
    . || {
    echo "❌ Docker build failed"
    exit 1
  }
  echo "✅ Image built: ingest-queue-reader:local"
else
  echo ""
  echo "⏭️  Skipping build (using existing image)"
fi

# Stop existing container if running
if docker ps --format '{{.Names}}' | grep -q '^lambda-ingest-debug$'; then
  echo "🛑 Stopping existing container..."
  docker stop lambda-ingest-debug >/dev/null 2>&1 || true
  docker rm lambda-ingest-debug >/dev/null 2>&1 || true
fi

# Run Lambda container
echo ""
echo "🚀 Starting Lambda container..."
echo "   Runtime API: http://localhost:9001"
echo "   Debugger: localhost:9229"
echo ""

docker run -d --rm --name lambda-ingest-debug \
  -p 9001:8080 \
  -p 9229:9229 \
  -e NODE_OPTIONS="--enable-source-maps --inspect=0.0.0.0:9229 --inspect-brk" \
  -e AWS_LAMBDA_RUNTIME_API=localhost:9001 \
  -e DB_SECRET_ARN="$DB_SECRET_ARN" \
  -e OPENAI_SECRET_ARN="${OPENAI_SECRET_ARN:-}" \
  -e DB_HOST="$DB_HOST" \
  -e DB_PORT="$DB_PORT" \
  -e DB_NAME="$DB_NAME" \
  -e LOG_LEVEL="debug" \
  --add-host=host.docker.internal:host-gateway \
  -v "${HOME}/.aws:/root/.aws:ro" \
  ingest-queue-reader:local || {
  echo "❌ Failed to start container"
  docker logs lambda-ingest-debug 2>&1 | tail -20 || true
  exit 1
}

echo "✅ Lambda container started!"
echo ""
echo "🐛 To debug:"
echo "   1. Connect debugger to localhost:9229"
echo "   2. Invoke with: curl -X POST http://localhost:9001/2015-03-31/functions/function/invocations -H 'Content-Type: application/json' -d @sqs-message.json | jq"
echo ""
echo "📋 Container logs:"
docker logs -f lambda-ingest-debug
