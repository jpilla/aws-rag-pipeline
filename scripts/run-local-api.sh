#!/usr/bin/env bash
# Run API locally with real database connection
# Usage: ./scripts/run-local-api.sh [--debug]

set -euo pipefail

# Check for debug flag
DEBUG_MODE=false
if [[ "${1:-}" == "--debug" ]]; then
  DEBUG_MODE=true
fi

# Source shared utilities and setup
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source the setup script - it exports all needed variables
# We need to source it to get the variables into this shell
# Pass --no-tunnel because we handle tunnel setup below
source "${SCRIPT_DIR}/setup-local-env.sh" --no-tunnel

# Verify credentials were set by the sourced script
if [ -z "${DB_USER:-}" ] || [ -z "${DB_PASSWORD:-}" ]; then
  echo "❌ Error: DB_USER or DB_PASSWORD not set after sourcing setup script!"
  echo "💡 This shouldn't happen. Check setup-local-env.sh"
  exit 1
fi

# Check if tunnel is running, start if not
if ! check_tunnel; then
  echo "🌐 Starting database tunnel..."
  "${SCRIPT_DIR}/tunnel-db.sh" >/tmp/tunnel-db.log 2>&1 &
  TUNNEL_PID=$!
  echo $TUNNEL_PID > /tmp/tunnel-db.pid

  # Wait for tunnel to be ready (check port + connection)
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
    if ps -p $TUNNEL_PID > /dev/null 2>&1; then
      echo "⚠️  Tunnel process is running but port may not be accessible"
    else
      echo "⚠️  Tunnel process died. Check /tmp/tunnel-db.log for errors"
    fi
    exit 1
  fi

  if ps -p $TUNNEL_PID > /dev/null 2>&1; then
    echo "✅ Tunnel started (PID: $TUNNEL_PID). Logs: /tmp/tunnel-db.log"
    echo "⚠️  Run 'kill $TUNNEL_PID' to stop the tunnel"
  fi
else
  echo "✅ Tunnel already running on port 5432"
  # Verify tunnel is actually accepting connections
  if ! timeout 2 bash -c "echo > /dev/tcp/localhost/5432" 2>/dev/null; then
    echo "⚠️  Warning: Tunnel process exists but port 5432 is not accepting connections"
    echo "💡 Try restarting the tunnel: ./scripts/tunnel-db.sh"
  fi
fi

# Ensure DB_HOST is set for tunnel (for docker-compose)
export DB_HOST="host.docker.internal"

# Export all variables for docker-compose to pick up
# Ensure all are exported (even if already set by setup script)
export DB_HOST DB_USER DB_PASSWORD DB_NAME DB_PORT DB_SSLMODE
export INGEST_QUEUE_URL AWS_REGION OPENAI_SECRET

echo ""
if [ "$DEBUG_MODE" = true ]; then
  echo "🐛 Starting debug service with environment:"
else
  echo "✅ Starting services with environment:"
fi
echo "   DB_HOST=$DB_HOST"
echo "   DB_NAME=$DB_NAME"
echo "   DB_PORT=$DB_PORT"
echo "   DB_USER=${DB_USER:-NOT SET}"
echo "   DB_PASSWORD=${DB_PASSWORD:+SET (hidden)}"
echo "   DB_SSLMODE=$DB_SSLMODE"
echo "   INGEST_QUEUE_URL=${INGEST_QUEUE_URL:-not set}"
echo ""
if [ "$DEBUG_MODE" = true ]; then
  echo "💡 Debugger will be available on port 9229"
  echo "   Attach your debugger to: localhost:9229"
  echo ""
fi

# Verify critical variables are set
if [ -z "${DB_USER:-}" ] || [ -z "${DB_PASSWORD:-}" ]; then
  echo "❌ Error: DB_USER or DB_PASSWORD not set!"
  echo "💡 Check that setup-local-env.sh fetched credentials correctly"
  exit 1
fi

# Ensure variables are in the environment when docker-compose runs
# Explicitly export them again to be sure they're available
export DB_HOST DB_USER DB_PASSWORD DB_NAME DB_PORT DB_SSLMODE
export INGEST_QUEUE_URL AWS_REGION OPENAI_SECRET

echo "🔍 Verifying environment variables before docker-compose:"
env | grep -E "^DB_|^INGEST_|^AWS_REGION|^OPENAI_SECRET" | sed 's/PASSWORD=.*/PASSWORD=***/' | sed 's/SECRET=.*/SECRET=***/'

# Run docker-compose with all environment variables exported
# They should be inherited from this shell, but explicitly pass critical ones
if [ "$DEBUG_MODE" = true ]; then
  # Ensure hello service is running (needed by api-debug)
  docker-compose up -d hello

  # Wait for hello service to be ready
  echo "⏳ Waiting for hello service to be ready..."
  until docker-compose exec hello wget -qO- http://localhost:3001/healthz >/dev/null 2>&1; do
    sleep 1
  done
  echo "✅ Hello service ready"

  # Run docker-compose with debug profile - starts api-debug service
  docker-compose --profile debug up -d api-debug

  echo ""
  echo "✅ Debug service started!"
  echo "   API: http://localhost:${API_HOST_PORT:-3000}"
  echo "   Debugger: localhost:9229"
  echo "   Use 'docker-compose logs -f api-debug' to view logs"
else
  docker-compose up -d
fi
