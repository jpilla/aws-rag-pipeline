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

# Ensure AWS_REGION is available for Docker container
if [ -z "${AWS_REGION:-}" ] && [ -n "${AWS_DEFAULT_REGION:-}" ]; then
  export AWS_REGION="$AWS_DEFAULT_REGION"
fi

# Check/start tunnel if needed (reuse logic from run-local-api.sh)
if [ "$NO_TUNNEL" = false ]; then
  if ! check_tunnel; then
    echo "🌐 Starting database tunnel..."
    "${SCRIPT_DIR}/tunnel-db.sh" >/tmp/tunnel-db.log 2>&1 &
    TUNNEL_PID=$!
    echo $TUNNEL_PID > /tmp/tunnel-db.pid

    # Wait for tunnel to be ready
    echo "⏳ Waiting for tunnel to be ready..."
    MAX_WAIT=15
    WAITED=0
    while [ $WAITED -lt $MAX_WAIT ]; do
      if check_tunnel && timeout 2 bash -c "echo > /dev/tcp/localhost/5432" 2>/dev/null; then
        echo "✅ Tunnel is ready (took ${WAITED}s)"
        break
      fi
      sleep 1
      WAITED=$((WAITED + 1))
    done

    if [ $WAITED -ge $MAX_WAIT ]; then
      echo "❌ Tunnel failed to become ready after ${MAX_WAIT}s"
      echo "📋 Check tunnel logs: /tmp/tunnel-db.log"
      exit 1
    fi
  else
    echo "✅ Tunnel already running on port 5432"
  fi

  # Ensure DB_HOST is set for tunnel
  export DB_HOST="host.docker.internal"
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
echo "🔍 Environment variables being passed:"
echo "   DB_SECRET_ARN=${DB_SECRET_ARN:+SET}"
if [ -n "${OPENAI_SECRET_ARN:-}" ]; then
  echo "   OPENAI_SECRET_ARN=${OPENAI_SECRET_ARN:+SET} (from stack)"
elif [ -n "${OPENAI_SECRET:-}" ]; then
  echo "   OPENAI_SECRET=${OPENAI_SECRET:+SET} (from shell)"
fi
echo "   DB_HOST=${DB_HOST}"
echo "   DB_PORT=${DB_PORT}"
echo "   DB_NAME=${DB_NAME}"
echo "   AWS_REGION=${AWS_REGION:-${AWS_DEFAULT_REGION:-NOT SET}}"
echo ""

# For local debugging, check if OPENAI_SECRET is available (fallback to OPENAI_SECRET_ARN from stack)
if [ -z "${OPENAI_SECRET_ARN:-}" ] && [ -z "${OPENAI_SECRET:-}" ]; then
  echo "❌ Error: Neither OPENAI_SECRET_ARN (from stack) nor OPENAI_SECRET (from shell) is set!"
  echo "💡 Either set OPENAI_SECRET in your shell or ensure your CDK stack has OpenAISecretArn output"
  exit 1
fi

# Build environment variables for Docker
DOCKER_ENV_VARS=(
  -e NODE_OPTIONS="--enable-source-maps"
  -e DB_SECRET_ARN="$DB_SECRET_ARN"
  -e DB_HOST="$DB_HOST"
  -e DB_PORT="${DB_PORT:-5432}"
  -e DB_NAME="$DB_NAME"
  -e LOG_LEVEL="debug"
  -e LAMBDA_DEBUG="true"
  -e AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
  -e AWS_PROFILE="${AWS_PROFILE:-}"
  -e AWS_LAMBDA_EXEC_WRAPPER=/var/task/debug-wrapper.sh
)

# Add OpenAI secret (either ARN or direct value)
if [ -n "${OPENAI_SECRET_ARN:-}" ]; then
  DOCKER_ENV_VARS+=( -e OPENAI_SECRET_ARN="$OPENAI_SECRET_ARN" )
elif [ -n "${OPENAI_SECRET:-}" ]; then
  DOCKER_ENV_VARS+=( -e OPENAI_SECRET="$OPENAI_SECRET" )
fi

docker run -d --rm --name lambda-ingest-debug \
  -p 9001:8080 \
  -p 9229:9229 \
  "${DOCKER_ENV_VARS[@]}" \
  --add-host=host.docker.internal:host-gateway \
  -v "${HOME}/.aws:/root/.aws:ro" \
  -v "${SCRIPT_DIR}/../lambdas/ingest-queue-reader/debug-wrapper.sh:/var/task/debug-wrapper.sh:ro" \
  ingest-queue-reader:local || {
  echo "❌ Failed to start container"
  docker logs lambda-ingest-debug 2>&1 | tail -20 || true
  exit 1
}

echo "✅ Lambda container started!"
echo ""
echo "🐛 Debug: Attach to localhost:9229, then invoke with:"
echo "   curl -X POST http://localhost:9001/2015-03-31/functions/function/invocations -H 'Content-Type: application/json' -d @lambda-test-message.json"
echo ""
echo "📋 Logs: docker logs -f lambda-ingest-debug"
echo "🛑 Stop: make stop-lambda-debug"
