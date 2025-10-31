#!/usr/bin/env bash
# Helper script to connect local API to real RDS database
# Usage: source scripts/connect-real-db.sh

# Detect if script is being sourced
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  # Script is being executed directly - strict error handling is fine
  set -euo pipefail
  EXIT_CMD="exit"
else
  # Script is being sourced - NO error handling flags! (set -e/-u would kill the terminal)
  # Just set exit command to return
  EXIT_CMD="return"
fi

echo "🔐 Connecting to real database..."

# Set AWS region if not already set
if [ -z "${AWS_REGION:-}" ] && [ -z "${AWS_DEFAULT_REGION:-}" ]; then
  AWS_REGION=$(aws configure get region 2>/dev/null || echo "")
  if [ -z "$AWS_REGION" ]; then
    echo "⚠️  AWS region not set. Please set AWS_REGION or AWS_DEFAULT_REGION"
    echo "   Example: export AWS_REGION=us-east-1"
    $EXIT_CMD 1
  fi
  export AWS_REGION
  echo "✅ Using AWS region: $AWS_REGION"
fi

# Get your public IP for security group access
MY_IP=$(curl -s https://api.ipify.org || echo "")
if [ -z "$MY_IP" ]; then
  echo "⚠️  Couldn't detect your IP. Set DEV_IP manually."
else
  export DEV_IP="$MY_IP"
  echo "✅ Your IP: $MY_IP (set as DEV_IP)"
fi

# Fetch database credentials from Secrets Manager
echo "📦 Fetching database credentials from Secrets Manager..."
SECRET_NAME="embeddings-db-credentials"

if ! aws secretsmanager describe-secret --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
  echo "❌ Secret '$SECRET_NAME' not found. Make sure your stack is deployed."
  $EXIT_CMD 1
fi

SECRET_VALUE=$(aws secretsmanager get-secret-value \
  --secret-id "$SECRET_NAME" \
  --query SecretString \
  --output text) || {
  echo "❌ Failed to fetch secret value"
  $EXIT_CMD 1
}

export DB_USER=$(echo "$SECRET_VALUE" | jq -r '.username') || {
  echo "❌ Failed to parse username from secret"
  $EXIT_CMD 1
}

export DB_PASSWORD=$(echo "$SECRET_VALUE" | jq -r '.password') || {
  echo "❌ Failed to parse password from secret"
  $EXIT_CMD 1
}

# Get RDS Proxy endpoint from CDK outputs
echo "🔍 Finding RDS Proxy endpoint from CDK stack..."
# Get the root stack only (exact match, not nested stacks)
STACK_NAME=$(aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query "StackSummaries[?StackName == 'InfraStack'].StackName" \
  --output text 2>/dev/null | head -n1) || STACK_NAME=""

if [ -z "$STACK_NAME" ] || [ "$STACK_NAME" = "None" ]; then
  echo "⚠️  Couldn't find InfraStack. Set DB_HOST manually."
  echo "   Example: export DB_HOST=your-proxy-endpoint.proxy-xxxxx.us-east-1.rds.amazonaws.com"
else
  DB_HOST=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='RdsProxyEndpoint'].OutputValue" \
    --output text 2>/dev/null) || DB_HOST=""

  if [ -z "$DB_HOST" ]; then
    echo "⚠️  RDS Proxy endpoint not found in stack outputs. Set DB_HOST manually."
  else
    export DB_HOST="$DB_HOST"
    echo "✅ RDS Proxy endpoint: $DB_HOST"
  fi
fi

# Set remaining required env vars
export DB_PORT="${DB_PORT:-5432}"
export DB_NAME="${DB_NAME:-embeddings}"
export DB_SSLMODE="${DB_SSLMODE:-require}"

echo ""
echo "✅ Database connection configured!"
echo ""
echo "📋 Environment variables set:"
echo "   DB_HOST=$DB_HOST"
echo "   DB_PORT=$DB_PORT"
echo "   DB_NAME=$DB_NAME"
echo "   DB_USER=$DB_USER"
echo "   DB_PASSWORD=***"
echo "   DB_SSLMODE=$DB_SSLMODE"
if [ -n "${DEV_IP:-}" ]; then
  echo "   DEV_IP=$DEV_IP"
fi
echo ""
echo "🚀 Next steps:"
echo ""
echo "Option 1: Use Bastion Host Tunnel (Recommended for private subnets)"
echo "   1. In one terminal, start the tunnel: ./scripts/tunnel-db.sh"
echo "   2. Set DB_HOST=host.docker.internal (macOS/Windows) or host IP (Linux)"
echo "      The tunnel forwards localhost:5432 on your host to the RDS Proxy"
echo "   3. Start API: DB_HOST=host.docker.internal docker-compose up api"
echo ""
echo "Option 2: Direct connection (requires DEV_IP in security group)"
echo "   1. Deploy with DEV_IP if not already: DEV_IP=$DEV_IP cdk deploy"
echo "   2. Note: This only works if RDS Proxy is in a public subnet or"
echo "      you have a VPN/Direct Connect to your VPC"
echo ""
echo "⚠️  Note: If using docker-compose, the postgres service will still start"
echo "   but won't be used. This is fine and doesn't affect functionality."
