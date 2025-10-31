#!/usr/bin/env bash
# Script to create an SSH tunnel to RDS database through bastion host
# Uses AWS Systems Manager Session Manager for secure access without SSH keys
# Usage: ./scripts/tunnel-db.sh [local-port] [remote-host] [remote-port]

set -euo pipefail

LOCAL_PORT="${1:-5432}"
REMOTE_HOST="${2:-}"
REMOTE_PORT="${3:-5432}"

# Set AWS region if not already set
if [ -z "${AWS_REGION:-}" ] && [ -z "${AWS_DEFAULT_REGION:-}" ]; then
  AWS_REGION=$(aws configure get region 2>/dev/null || echo "")
  if [ -z "$AWS_REGION" ]; then
    echo "⚠️  AWS region not set. Please set AWS_REGION or AWS_DEFAULT_REGION"
    exit 1
  fi
  export AWS_REGION
fi

# Get bastion instance ID from CDK stack outputs
echo "🔍 Finding bastion instance..."
STACK_NAME=$(aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
  --query "StackSummaries[?StackName == 'InfraStack'].StackName" \
  --output text 2>/dev/null | head -n1) || STACK_NAME=""

if [ -z "$STACK_NAME" ] || [ "$STACK_NAME" = "None" ]; then
  echo "❌ Couldn't find InfraStack. Make sure your stack is deployed."
  exit 1
fi

BASTION_ID=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='BastionInstanceId'].OutputValue" \
  --output text 2>/dev/null) || BASTION_ID=""

if [ -z "$BASTION_ID" ]; then
  echo "❌ Bastion instance ID not found in stack outputs."
  exit 1
fi

# Get RDS Proxy endpoint if not provided
if [ -z "$REMOTE_HOST" ]; then
  REMOTE_HOST=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='RdsProxyEndpoint'].OutputValue" \
    --output text 2>/dev/null) || REMOTE_HOST=""

  if [ -z "$REMOTE_HOST" ]; then
    echo "❌ RDS Proxy endpoint not found. Please provide it as the second argument."
    echo "   Usage: $0 [local-port] [remote-host] [remote-port]"
    exit 1
  fi
fi

echo "✅ Bastion instance: $BASTION_ID"
echo "✅ Remote host: $REMOTE_HOST:$REMOTE_PORT"
echo "✅ Local port: $LOCAL_PORT"
echo ""
echo "🔐 Starting port forward tunnel..."
echo "   Connect to database using: localhost:$LOCAL_PORT"
echo ""
echo "ℹ️  This process will stay running to maintain the tunnel."
echo "   Open a NEW terminal window to run your application."
echo "   The tunnel will automatically forward connections."
echo ""
echo "⚠️  Press Ctrl+C to stop the tunnel"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Start SSM port forwarding session
aws ssm start-session \
  --target "$BASTION_ID" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$REMOTE_HOST\"],\"portNumber\":[\"$REMOTE_PORT\"],\"localPortNumber\":[\"$LOCAL_PORT\"]}"
