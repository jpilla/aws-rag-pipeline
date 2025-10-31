# ========== LOCAL DEVELOPMENT ==========

.PHONY: help build-api build-local run-local run-debug integration-tests prisma-migrate local-db test-migration stop-tunnel

help:
	@echo "Available targets:"
	@echo "  make build-api          - Build API service locally for debugging"
	@echo "  make build-local        - Build Docker images"
	@echo "  make run-local          - Build and run app with real database (auto-starts tunnel)"
	@echo "  make run-debug          - Build and run the app in debug mode"
	@echo "  make integration-tests  - Run integration tests"
	@echo "  make prisma-migrate     - Create new Prisma migration (usage: make prisma-migrate migration_name)"
	@echo "  make local-db           - Set up local development environment"
	@echo "  make test-migration     - Test Prisma migrations (uses local postgres)"
	@echo "  make stop-tunnel        - Stop the database tunnel"
	@echo "  make destroy-local      - Stop tunnel and remove all containers"

# --- LOCAL DEV ---
build-api:
	@echo "🔨 Building API service locally"
	cd services/api && npm run build

# --- DATABASE MIGRATIONS ---
# Usage: make prisma-migrate migration_name
# Examples:
#   make prisma-migrate init                    # Create initial migration
#   make prisma-migrate add_user_table         # Create migration for new table
#   make prisma-migrate add_updated_at         # Create migration for schema change
prisma-migrate:
	@echo "📝 Creating new Prisma migration"
	# filter-out removes 'prisma-migrate' from arguments, passes the rest to script
	./scripts/prisma-make.sh $(filter-out prisma-migrate,$(MAKECMDGOALS))

# --- FAST DEVELOPMENT WORKFLOW ---
local-db:
	@echo "🚀 Setting up local development environment"
	./scripts/dev.sh setup

test-migration:
	@echo "🧪 Testing Prisma migrations (fast feedback)"
	@echo "📦 Ensuring local Postgres is running..."
	@docker-compose up -d postgres
	@echo "⏳ Waiting for Postgres to be ready..."
	@until docker-compose exec postgres pg_isready -U postgres -d embeddings >/dev/null 2>&1; do \
		sleep 1; \
	done
	@echo "✅ Postgres ready"
	@./scripts/dev.sh test

# Allow make to pass through arguments (prevents "no rule to make target" errors)
%:
	@:

build-local:
	@echo "🔨 Building Docker images"
	docker-compose build

run-local: build-local
	@echo "🚀 Running app locally with real database"
	@echo "🔐 Setting up database tunnel and credentials..."
	@if ! command -v aws >/dev/null 2>&1; then \
		echo "❌ AWS CLI not found. Please install it."; \
		exit 1; \
	fi; \
	if ! command -v jq >/dev/null 2>&1; then \
		echo "❌ jq not found. Please install it: brew install jq"; \
		exit 1; \
	fi; \
	export DB_HOST="host.docker.internal"; \
	echo "✅ DB_HOST set to $$DB_HOST"; \
	if [ -z "$$DB_USER" ] || [ -z "$$DB_PASSWORD" ]; then \
		echo "📦 Auto-fetching database credentials from AWS Secrets Manager..."; \
		if [ -z "$$AWS_REGION" ] && [ -z "$$AWS_DEFAULT_REGION" ]; then \
			AWS_REGION=$$(aws configure get region 2>/dev/null || echo ""); \
			if [ -z "$$AWS_REGION" ]; then \
				echo "❌ AWS region not set. Please set AWS_REGION or AWS_DEFAULT_REGION"; \
				exit 1; \
			fi; \
			export AWS_REGION; \
		fi; \
		SECRET_NAME="embeddings-db-credentials"; \
		if ! aws secretsmanager describe-secret --secret-id "$$SECRET_NAME" >/dev/null 2>&1; then \
			echo "❌ Secret '$$SECRET_NAME' not found. Make sure your CDK stack is deployed."; \
			echo "   Run: cd infra && npx cdk deploy"; \
			exit 1; \
		fi; \
		SECRET_VALUE=$$(aws secretsmanager get-secret-value \
			--secret-id "$$SECRET_NAME" \
			--query SecretString \
			--output text 2>/dev/null) || { \
			echo "❌ Failed to fetch secret value"; \
			exit 1; \
		}; \
		DB_USER_VAL=$$(echo "$$SECRET_VALUE" | jq -r '.username' 2>/dev/null) || { \
			echo "❌ Failed to parse username from secret"; \
			exit 1; \
		}; \
		DB_PASSWORD_VAL=$$(echo "$$SECRET_VALUE" | jq -r '.password' 2>/dev/null) || { \
			echo "❌ Failed to parse password from secret"; \
			exit 1; \
		}; \
		export DB_USER="$$DB_USER_VAL"; \
		export DB_PASSWORD="$$DB_PASSWORD_VAL"; \
		export DB_NAME="$${DB_NAME:-embeddings}"; \
		export DB_PORT="$${DB_PORT:-5432}"; \
		export DB_SSLMODE="$${DB_SSLMODE:-require}"; \
		echo "✅ Credentials fetched: DB_USER=$$DB_USER, DB_NAME=$$DB_NAME, DB_PORT=$$DB_PORT"; \
	else \
		export DB_NAME="$${DB_NAME:-embeddings}"; \
		export DB_PORT="$${DB_PORT:-5432}"; \
		export DB_SSLMODE="$${DB_SSLMODE:-require}"; \
		echo "✅ Using provided DB credentials"; \
	fi; \
	if [ -z "$$INGEST_QUEUE_URL" ]; then \
		echo "📦 Auto-fetching INGEST_QUEUE_URL from CDK stack outputs..."; \
		if ! command -v aws >/dev/null 2>&1; then \
			echo "⚠️  AWS CLI not found. Please set INGEST_QUEUE_URL manually."; \
		else \
			STACK_NAME=$$(aws cloudformation list-stacks \
				--stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE \
				--query "StackSummaries[?StackName == 'InfraStack'].StackName" \
				--output text 2>/dev/null | head -n1) || STACK_NAME=""; \
			if [ -n "$$STACK_NAME" ] && [ "$$STACK_NAME" != "None" ]; then \
				QUEUE_URL=$$(aws cloudformation describe-stacks \
					--stack-name "$$STACK_NAME" \
					--query "Stacks[0].Outputs[?OutputKey=='IngestQueueUrl'].OutputValue" \
					--output text 2>/dev/null) || QUEUE_URL=""; \
				if [ -n "$$QUEUE_URL" ]; then \
					export INGEST_QUEUE_URL="$$QUEUE_URL"; \
					echo "✅ INGEST_QUEUE_URL fetched: $$INGEST_QUEUE_URL"; \
				else \
					echo "⚠️  INGEST_QUEUE_URL not found in stack outputs. Please set manually."; \
				fi; \
			else \
				echo "⚠️  InfraStack not found. Please set INGEST_QUEUE_URL manually."; \
			fi; \
		fi; \
	else \
		echo "✅ Using provided INGEST_QUEUE_URL"; \
	fi; \
	if [ -z "$$AWS_REGION" ] && [ -z "$$AWS_DEFAULT_REGION" ]; then \
		AWS_REGION=$$(aws configure get region 2>/dev/null || echo ""); \
		if [ -n "$$AWS_REGION" ]; then \
			export AWS_REGION; \
			echo "✅ AWS_REGION set to: $$AWS_REGION"; \
		else \
			echo "⚠️  AWS_REGION not set. Please set AWS_REGION or AWS_DEFAULT_REGION"; \
		fi; \
	fi; \
	if [ -z "$$OPENAI_SECRET" ]; then \
		echo "⚠️  OPENAI_SECRET not set. Required for embedding generation."; \
		echo "   Set it manually: export OPENAI_SECRET=your-key"; \
	fi; \
	echo "🌐 Starting database tunnel..."; \
	if lsof -i :5432 >/dev/null 2>&1; then \
		echo "✅ Tunnel already running on port 5432"; \
	else \
		echo "🚇 Starting tunnel in background..."; \
		./scripts/tunnel-db.sh >/tmp/tunnel-db.log 2>&1 & \
		TUNNEL_PID=$$!; \
		echo $$TUNNEL_PID > /tmp/tunnel-db.pid; \
		sleep 3; \
		if ps -p $$TUNNEL_PID > /dev/null 2>&1; then \
			echo "✅ Tunnel started (PID: $$TUNNEL_PID). Logs: /tmp/tunnel-db.log"; \
			echo "⚠️  Run 'kill $$TUNNEL_PID' to stop the tunnel, or 'pkill -f tunnel-db.sh'"; \
		else \
			echo "❌ Tunnel failed to start. Check /tmp/tunnel-db.log"; \
			exit 1; \
		fi; \
	fi; \
	echo "✅ Starting services..."; \
	docker-compose up -d

run-debug: build-api
	@echo "🐛 Starting app in debug mode with local Postgres"
	@echo "💡 Make sure you have AWS_PROFILE set and INGEST_QUEUE_URL in your environment"
	# Ensure postgres is running first
	docker-compose up -d postgres
	# Wait for postgres to be ready
	@echo "⏳ Waiting for Postgres to be ready..."
	@until docker-compose exec postgres pg_isready -U postgres -d embeddings >/dev/null 2>&1; do \
		sleep 1; \
	done
	@echo "✅ Postgres ready, starting debug service..."
	docker-compose --profile debug up -d api-debug

integration-tests:
	@echo "🧪 Building and running integration tests against local service"
	docker-compose build integration-tests
	docker-compose run --rm integration-tests

stop-tunnel:
	@echo "🛑 Stopping database tunnel..."
	@if [ -f /tmp/tunnel-db.pid ]; then \
		TUNNEL_PID=$$(cat /tmp/tunnel-db.pid); \
		if ps -p $$TUNNEL_PID > /dev/null 2>&1; then \
			kill $$TUNNEL_PID; \
			echo "✅ Tunnel stopped (PID: $$TUNNEL_PID)"; \
		else \
			echo "⚠️  Tunnel process not found"; \
		fi; \
		rm -f /tmp/tunnel-db.pid; \
	else \
		if pkill -f tunnel-db.sh >/dev/null 2>&1; then \
			echo "✅ Tunnel stopped"; \
		else \
			echo "⚠️  No tunnel process found"; \
		fi; \
	fi

destroy-local: stop-tunnel
	@echo "🧹 Stopping and removing local containers"
	docker-compose down -v --remove-orphans

# ========== AWS DEPLOYMENT ==========

.PHONY: deploy-cloud-resources cdk-diff destroy-cloud-resources destroy-local

deploy-cloud-resources:
	@echo "🚢 Deploying with CDK (CDK will handle ECR and image management)"
	cd infra && npx cdk deploy

cdk-diff:
	@echo "🔍 Showing CDK diff"
	cd infra && npx cdk diff

destroy-cloud-resources:
	@echo "💣 Destroying CDK stack (includes ECR cleanup)"
	cd infra && npx cdk destroy --force
