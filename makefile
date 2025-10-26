# ========== LOCAL DEVELOPMENT ==========

.PHONY: help build-api build-local run-local run-debug integration-tests prisma-migrate local-db test-migration

help:
	@echo "Available targets:"
	@echo "  make build-api          - Build API service locally for debugging"
	@echo "  make build-local        - Build and run the app locally"
	@echo "  make run-debug          - Build and run the app in debug mode"
	@echo "  make integration-tests  - Run integration tests"
	@echo "  make prisma-migrate     - Create new Prisma migration (usage: make prisma-migrate migration_name)"
	@echo "  make local-db           - Set up local development environment"
	@echo "  make test-migration     - Test Prisma migrations (fast feedback)"

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
	./scripts/dev.sh test

# Allow make to pass through arguments (prevents "no rule to make target" errors)
%:
	@:

build-local:
	@echo "🔨 Building Docker images"
	docker-compose build

run-local: build-local
	@echo "🚀 Running app locally"
	docker-compose up -d

run-debug: build-api
	@echo "🐛 Starting app in debug mode"
	docker-compose --profile debug up -d api-debug

integration-tests:
	@echo "🧪 Building and running integration tests against local service"
	docker-compose build integration-tests
	docker-compose run --rm integration-tests

destroy-local:
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
