# ========== LOCAL DEVELOPMENT ==========

.PHONY: help build-api build-local run-local run-debug integration-tests prisma-migrate

help:
	@echo "Available targets:"
	@echo "  make build-api          - Build API service locally for debugging"
	@echo "  make build-local        - Build and run the app locally"
	@echo "  make run-debug          - Build and run the app in debug mode"
	@echo "  make integration-tests  - Run integration tests"
	@echo "  make prisma-migrate     - Create new Prisma migration (usage: make prisma-migrate migration_name)"

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
	cd services/api && ./scripts/prisma-make.sh $(filter-out prisma-migrate,$(MAKECMDGOALS))

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
	@echo "🧪 Running integration tests against local service"
	docker-compose run --rm integration-tests

destroy-local:
	@echo "🧹 Stopping and removing local containers"
	docker-compose down -v --remove-orphans

# ========== AWS DEPLOYMENT ==========

.PHONY: deploy-cloud-resources cdk-diff destroy-cloud-resources destroy-local

deploy-cloud-resources:
	@echo "🚢 Deploying with CDK (CDK will handle ECR and image management)"
	cd infra && npx cdk deploy --no-rollback

cdk-diff:
	@echo "🔍 Showing CDK diff"
	cd infra && npx cdk diff

destroy-cloud-resources:
	@echo "💣 Destroying CDK stack (includes ECR cleanup)"
	cd infra && npx cdk destroy --force
