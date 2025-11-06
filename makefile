# ========== LOCAL DEVELOPMENT ==========

.PHONY: help build-api build-local run-local run-debug integration-tests prisma-migrate test-migration stop-tunnel build-lambda

help:
	@echo "Available targets:"
	@echo "  make build-api          - Build API service locally for debugging"
	@echo "  make build-local        - Build Docker images"
	@echo "  make run-local          - Build and run app with real database (auto-starts tunnel)"
	@echo "  make run-debug          - Build and run the app in debug mode"
	@echo "  make integration-tests  - Run integration tests"
	@echo "  make prisma-migrate     - Create new Prisma migration (usage: make prisma-migrate migration_name)"
	@echo "  make test-migration     - Test Prisma migrations (uses local postgres)"
	@echo "  make stop-tunnel        - Stop the database tunnel"
	@echo "  make destroy-local      - Stop tunnel and remove all containers"
	@echo ""
	@echo "Lambda:"
	@echo "  make build-lambda       - Build Lambda service and run tests"
	@echo "  make debug-lambda       - Build and run Lambda locally with real DB (via tunnel)"
	@echo "  make debug-lambda-no-build - Start Lambda without rebuilding"
	@echo "  make stop-lambda-debug  - Stop Lambda debug container"

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
	docker-compose build api

run-local:
	@echo "🚀 Running app locally with real database"
	@bash scripts/run-local-api.sh

run-debug: build-api
	@echo "🐛 Running app in debug mode with real database"
	@echo "🔨 Building Docker image for api-debug service..."
	@docker-compose build api-debug
	@bash scripts/run-local-api.sh --debug

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

.PHONY: bootstrap-cloud-resources deploy-cloud-resources cdk-diff destroy-cloud-resources destroy-local

bootstrap-cloud-resources:
	@echo "🔧 Bootstrapping CDK environment (first time only)"
	@echo "Ensuring infra dependencies are installed..."
	@cd infra && npm install >/dev/null 2>&1 || (echo "❌ Failed to install infra dependencies. Run: cd infra && npm install" && exit 1)
	@echo "Creating RDS service-linked role..."
	@aws iam create-service-linked-role --aws-service-name rds.amazonaws.com 2>/dev/null || \
		echo "⚠️  RDS service-linked role may already exist (this is OK)"
	@echo "Bootstrapping CDK..."
	@cd infra && npx cdk bootstrap
	@echo "✅ Bootstrap complete!"

deploy-cloud-resources:
	@echo "🚢 Deploying with CDK (CDK will handle ECR and image management)"
	@echo "Ensuring infra dependencies are installed..."
	@cd infra && npm install >/dev/null 2>&1 || (echo "❌ Failed to install infra dependencies. Run: cd infra && npm install" && exit 1)
	cd infra && npx cdk deploy

cdk-diff:
	@echo "🔍 Showing CDK diff"
	cd infra && npx cdk diff

destroy-cloud-resources:
	@echo "💣 Destroying CDK stack (includes ECR cleanup)"
	cd infra && npx cdk destroy --force

# ========== LAMBDA BUILD & TEST ==========

.PHONY: build-lambda

build-lambda:
	@echo "🔨 Building Lambda Docker image (includes build and tests)"
	docker build -f lambdas/ingest-queue-reader/Dockerfile -t ingest-queue-reader:latest .

# ========== LAMBDA LOCAL DEBUGGING ==========

.PHONY: debug-lambda stop-lambda-debug

debug-lambda:
	@echo "🐛 Setting up Lambda local debugging with real database..."
	@./scripts/debug-lambda-local.sh

stop-lambda-debug:
	@echo "🛑 Stopping Lambda debug container..."
	@if docker ps --format '{{.Names}}' | grep -q '^lambda-ingest-debug$$'; then \
		docker stop lambda-ingest-debug >/dev/null 2>&1 && echo "✅ Lambda stopped"; \
	else \
		echo "⚠️  Lambda container not running"; \
	fi
