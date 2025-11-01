#!/usr/bin/env bash
# Shared AWS/CDK configuration utilities
# Usage: source scripts/lib/aws-config.sh

# Detect if script is being sourced or executed
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  set -euo pipefail
  EXIT_CMD="exit"
else
  EXIT_CMD="return"
fi

# Ensure AWS CLI and jq are available
check_prerequisites() {
  if ! command -v aws >/dev/null 2>&1; then
    echo "❌ AWS CLI not found. Please install it." >&2
    $EXIT_CMD 1
  fi

  if ! command -v jq >/dev/null 2>&1; then
    echo "❌ jq not found. Install with: brew install jq" >&2
    $EXIT_CMD 1
  fi
}

# Ensure AWS region is set (auto-detects if not)
ensure_aws_region() {
  if [ -z "${AWS_REGION:-}" ] && [ -z "${AWS_DEFAULT_REGION:-}" ]; then
    AWS_REGION=$(aws configure get region 2>/dev/null || echo "")
    if [ -z "$AWS_REGION" ]; then
      echo "❌ AWS region not set. Set AWS_REGION or AWS_DEFAULT_REGION" >&2
      $EXIT_CMD 1
    fi
    export AWS_REGION
  elif [ -z "${AWS_REGION:-}" ]; then
    export AWS_REGION="$AWS_DEFAULT_REGION"
  fi
}

# Find CDK stack name (defaults to InfraStack)
find_stack_name() {
  local stack_name="${1:-InfraStack}"

  local found=$(aws cloudformation list-stacks \
    --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
    --query "StackSummaries[?StackName == '$stack_name'].StackName" \
    --output text 2>/dev/null | head -n1) || found=""

  if [ -z "$found" ] || [ "$found" = "None" ]; then
    echo ""
    return 1
  fi

  echo "$found"
  return 0
}

# Get stack output value
get_stack_output() {
  local stack_name="$1"
  local output_key="$2"

  local value=$(aws cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --query "Stacks[0].Outputs[?OutputKey=='$output_key'].OutputValue" \
    --output text 2>/dev/null) || value=""

  if [ "$value" = "None" ] || [ -z "$value" ]; then
    echo ""
    return 1
  fi

  echo "$value"
  return 0
}

# Fetch database credentials from Secrets Manager
fetch_db_credentials() {
  local secret_name="${1:-embeddings-db-credentials}"

  if ! aws secretsmanager describe-secret --secret-id "$secret_name" >/dev/null 2>&1; then
    echo "❌ Secret '$secret_name' not found. Make sure your stack is deployed." >&2
    $EXIT_CMD 1
  fi

  local secret_value=$(aws secretsmanager get-secret-value \
    --secret-id "$secret_name" \
    --query SecretString \
    --output text 2>/dev/null) || {
    echo "❌ Failed to fetch secret value" >&2
    $EXIT_CMD 1
  }

  export DB_USER=$(echo "$secret_value" | jq -r '.username') || {
    echo "❌ Failed to parse username from secret" >&2
    $EXIT_CMD 1
  }

  export DB_PASSWORD=$(echo "$secret_value" | jq -r '.password') || {
    echo "❌ Failed to parse password from secret" >&2
    $EXIT_CMD 1
  }
}

# Fetch OpenAI API key from Secrets Manager
fetch_openai_secret() {
  local secret_arn="${1:-}"

  if [ -z "$secret_arn" ]; then
    return 0  # OpenAI secret is optional
  fi

  local secret_value=$(aws secretsmanager get-secret-value \
    --secret-id "$secret_arn" \
    --query SecretString \
    --output text 2>/dev/null) || {
    echo "⚠️  Failed to fetch OpenAI secret (optional)" >&2
    return 0  # Don't fail if OpenAI secret can't be fetched
  }

  export OPENAI_SECRET="$secret_value"
}

# Setup database environment variables
setup_db_env() {
  local use_tunnel="${1:-true}"
  local stack_name="${2:-}"

  # Set defaults
  export DB_PORT="${DB_PORT:-5432}"
  export DB_NAME="${DB_NAME:-embeddings}"

  # If stack name provided, try to get RDS Proxy endpoint
  if [ -n "$stack_name" ]; then
    local db_host_proxy=$(get_stack_output "$stack_name" "RdsProxyEndpoint")
    if [ -n "$db_host_proxy" ]; then
      if [ "$use_tunnel" = "true" ]; then
        export DB_HOST="host.docker.internal"
      else
        export DB_HOST="$db_host_proxy"
      fi
    fi
  fi

  # Default to tunnel if DB_HOST not set
  if [ -z "${DB_HOST:-}" ]; then
    if [ "$use_tunnel" = "true" ]; then
      export DB_HOST="host.docker.internal"
    fi
  fi

  export DB_SSLMODE="${DB_SSLMODE:-require}"
}

# Check if database tunnel is running
check_tunnel() {
  # Check if tunnel PID file exists and process is running
  if [ -f /tmp/tunnel-db.pid ]; then
    local pid=$(cat /tmp/tunnel-db.pid 2>/dev/null)
    if ps -p "$pid" >/dev/null 2>&1; then
      return 0
    fi
  fi

  # Also check if session-manager is running on port 5432
  if lsof -i :5432 >/dev/null 2>&1; then
    if lsof -i :5432 2>/dev/null | grep -q "session-m"; then
      return 0
    fi
  fi

  return 1
}

# Ensure tunnel is running (or prompt user)
ensure_tunnel() {
  if check_tunnel; then
    return 0
  fi

  echo "⚠️  Database tunnel not running on port 5432" >&2
  echo "💡 Start it in another terminal: ./scripts/tunnel-db.sh" >&2

  if [ -t 0 ]; then
    # Interactive terminal
    echo ""
    read -p "Press Enter after starting tunnel, or Ctrl+C to cancel..."
    if ! check_tunnel; then
      echo "❌ Tunnel still not running on port 5432" >&2
      $EXIT_CMD 1
    fi
  else
    # Non-interactive (e.g., from makefile)
    $EXIT_CMD 1
  fi
}

# Get Lambda configuration from stack
get_lambda_config() {
  local stack_name="$1"

  local db_secret_arn=$(get_stack_output "$stack_name" "DatabaseSecretArn")
  local openai_secret_arn=$(get_stack_output "$stack_name" "OpenAISecretArn")

  # If OpenAI secret not in outputs, try to find by name pattern
  if [ -z "$openai_secret_arn" ]; then
    openai_secret_arn=$(aws secretsmanager list-secrets \
      --query "SecretList[?starts_with(Name, 'InfraStack-OpenAISecret')].ARN" \
      --output text 2>/dev/null | head -n1) || openai_secret_arn=""
  fi

  echo "$db_secret_arn|$openai_secret_arn"
}

# Export variables for use in parent scripts
export -f check_prerequisites
export -f ensure_aws_region
export -f find_stack_name
export -f get_stack_output
export -f fetch_db_credentials
export -f fetch_openai_secret
export -f setup_db_env
export -f check_tunnel
export -f ensure_tunnel
export -f get_lambda_config
