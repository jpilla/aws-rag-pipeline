#!/usr/bin/env bash
# Helper script to run docker-compose with real database via bastion tunnel
# Usage: ./scripts/run-with-real-db.sh [make target]

set -euo pipefail

MAKE_TARGET="${1:-run-local}"

echo "🔐 Setting up real database connection..."

# First, check if tunnel might be running (optional - we'll warn if it's not)
if ! lsof -i :5432 >/dev/null 2>&1; then
  echo "⚠️  Warning: No process detected listening on port 5432"
  echo "   Make sure you have the tunnel running in another terminal:"
  echo "   ./scripts/tunnel-db.sh"
  echo ""
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Source the connect-real-db script to get credentials
# But we need to override DB_HOST, so we'll do it step by step
echo "📦 Fetching database credentials from AWS..."

# Set AWS region if not already set
if [ -z "${AWS_REGION:-}" ] && [ -z "${AWS_DEFAULT_REGION:-}" ]; then
  AWS_REGION=$(aws configure get region 2>/dev/null || echo "")
  if [ -z "$AWS_REGION" ]; then
    echo "⚠️  AWS region not set. Please set AWS_REGION or AWS_DEFAULT_REGION"
    exit 1
  fi
  export AWS_REGION
fi

# Fetch database credentials from Secrets Manager
SECRET_NAME="embeddings-db-credentials"

if ! aws secretsmanager describe-secret --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
  echo "❌ Secret '$SECRET_NAME' not found. Make sure your stack is deployed."
  exit 1
fi

SECRET_VALUE=$(aws secretsmanager get-secret-value \
  --secret-id "$SECRET_NAME" \
  --query SecretString \
  --output text) || {
  echo "❌ Failed to fetch secret value"
  exit 1
}

export DB_USER=$(echo "$SECRET_VALUE" | jq -r '.username') || {
  echo "❌ Failed to parse username from secret"
  exit 1
}

export DB_PASSWORD=$(echo "$SECRET_VALUE" | jq -r '.password') || {
  echo "❌ Failed to parse password from secret"
  exit 1
}

# Set database connection variables for tunnel
export DB_HOST="host.docker.internal"
export DB_PORT="${DB_PORT:-5432}"
export DB_NAME="${DB_NAME:-embeddings}"
export DB_SSLMODE="${DB_SSLMODE:-require}"

echo "✅ Database credentials loaded"
echo ""
echo "📋 Configuration:"
echo "   DB_HOST=$DB_HOST (via tunnel)"
echo "   DB_PORT=$DB_PORT"
echo "   DB_NAME=$DB_NAME"
echo "   DB_USER=$DB_USER"
echo "   DB_SSLMODE=$DB_SSLMODE"
echo ""
echo "🚀 Running: make $MAKE_TARGET"
echo ""

# Run the make target with all env vars
make "$MAKE_TARGET"
