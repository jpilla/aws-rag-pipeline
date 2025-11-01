#!/usr/bin/env bash
# Setup local development environment with real AWS resources
# Usage: source scripts/setup-local-env.sh [--no-tunnel] [--no-db-creds]

set -euo pipefail

NO_TUNNEL=false
NO_DB_CREDS=false

# Parse flags
while [[ $# -gt 0 ]]; do
  case $1 in
    --no-tunnel)
      NO_TUNNEL=true
      shift
      ;;
    --no-db-creds)
      NO_DB_CREDS=true
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: source $0 [--no-tunnel] [--no-db-creds]" >&2
      return 1
      ;;
  esac
done

# Source shared utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/aws-config.sh"

echo "🔐 Setting up local environment with real AWS resources..."

# Check prerequisites
check_prerequisites

# Ensure AWS region
ensure_aws_region
echo "✅ AWS region: ${AWS_REGION}"

# Find CDK stack
STACK_NAME=$(find_stack_name "InfraStack")
if [ -z "$STACK_NAME" ]; then
  echo "❌ InfraStack not found. Deploy it first: cd infra && npx cdk deploy" >&2
  return 1
fi
echo "✅ Found stack: $STACK_NAME"

# Fetch database credentials if needed
if [ "$NO_DB_CREDS" = false ]; then
  if [ -z "${DB_USER:-}" ] || [ -z "${DB_PASSWORD:-}" ]; then
    echo "📦 Fetching database credentials from Secrets Manager..."
    fetch_db_credentials "embeddings-db-credentials"
    echo "✅ Database credentials fetched"
  else
    echo "✅ Using provided database credentials"
  fi
fi

# Setup database environment
setup_db_env "${NO_TUNNEL}" "$STACK_NAME"

# Ensure tunnel if needed
if [ "$NO_TUNNEL" = false ]; then
  if ! ensure_tunnel; then
    echo "💡 Start tunnel with: ./scripts/tunnel-db.sh" >&2
    return 1
  fi
  echo "✅ Database tunnel is running"
fi

# Get additional stack outputs
INGEST_QUEUE_URL=$(get_stack_output "$STACK_NAME" "IngestQueueUrl")
if [ -n "$INGEST_QUEUE_URL" ]; then
  export INGEST_QUEUE_URL
  echo "✅ INGEST_QUEUE_URL: $INGEST_QUEUE_URL"
fi

# Export configuration for Lambda
LAMBDA_CONFIG=$(get_lambda_config "$STACK_NAME")
export DB_SECRET_ARN=$(echo "$LAMBDA_CONFIG" | cut -d'|' -f1)
export OPENAI_SECRET_ARN=$(echo "$LAMBDA_CONFIG" | cut -d'|' -f2)

if [ -n "$DB_SECRET_ARN" ]; then
  echo "✅ DB_SECRET_ARN: $DB_SECRET_ARN"
fi
if [ -n "$OPENAI_SECRET_ARN" ]; then
  echo "✅ OPENAI_SECRET_ARN: $OPENAI_SECRET_ARN"
  fetch_openai_secret "$OPENAI_SECRET_ARN"
elif [ "$NO_DB_CREDS" = false ]; then
  echo "⚠️  OPENAI_SECRET_ARN not found (optional)"
fi

echo ""
echo "✅ Local environment configured!"
echo "📋 Database configuration:"
echo "   DB_HOST=${DB_HOST}"
echo "   DB_PORT=${DB_PORT}"
echo "   DB_NAME=${DB_NAME}"
echo "   DB_USER=${DB_USER}"
echo "   DB_PASSWORD=***"
echo "   DB_SSLMODE=${DB_SSLMODE}"
