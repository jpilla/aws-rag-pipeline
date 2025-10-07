IMAGE_TAG = $(shell git rev-parse --short HEAD)
IMAGE_NAME := express-api-docker
ECR_ACCOUNT_ID := 525127693073
ECR_REGION := eu-west-1
ECR_REPO := $(ECR_ACCOUNT_ID).dkr.ecr.$(ECR_REGION).amazonaws.com/$(IMAGE_NAME)

# ========== TARGETS ==========

.PHONY: help build-local build-image-local run-local push-image login-ecr deploy integration-tests

help:
	@echo "Available targets:"
	@echo "  make build-local        - Build and run the app locally"
	@echo "  make build-image-local  - Build the image with docker-compose only"
	@echo "  make integration-tests  - Run integration tests"
	@echo "  make deploy             - Build image, push to ECR, and deploy via CDK"

# --- LOCAL DEV ---
build-image-local:
	@echo "🧱 Building app image locally (tag: prod-$(IMAGE_TAG))"
	IMAGE_TAG=$(IMAGE_TAG) docker-compose build api

execute-local:
	@echo "🚀 Running app locally"
	IMAGE_TAG=$(IMAGE_TAG) docker-compose up -d api

run-local: build-image-local execute-local

api-debug-up:
	env -u NODE_OPTIONS docker compose up --build -d api-debug

integration-tests:
	@echo "🧪 Running integration tests against local service"
	IMAGE_TAG=$(IMAGE_TAG) docker-compose run --rm integration-tests

# --- ECR + CDK DEPLOY ---
login-ecr:
	@echo "🔐 Logging in to Amazon ECR"
	aws ecr get-login-password --region $(ECR_REGION) \
	| docker login --username AWS --password-stdin $(ECR_REPO)

push-image: login-ecr build-image-local
	@echo "🏷️ Tagging and pushing image to ECR"
	docker tag $(IMAGE_NAME):prod-$(IMAGE_TAG) $(ECR_REPO):prod-$(IMAGE_TAG)
	docker push $(ECR_REPO):prod-$(IMAGE_TAG)

deploy: push-image
	@echo "🚢 Deploying with CDK (tag: prod-$(IMAGE_TAG))"
	cd infra && npx cdk deploy -c ecrRepo=$(ECR_REPO) -c imageTag=prod-$(IMAGE_TAG)

destroy-local:
	@echo "🧹 Stopping and removing local containers"
	docker-compose down -v --remove-orphans

remove-image:
	@echo "🗑️ Removing ECR image prod-$(IMAGE_TAG)"
	aws ecr batch-delete-image \
	  --repository-name $(IMAGE_NAME) \
	  --image-ids imageTag=prod-$(IMAGE_TAG) \
	  --region $(ECR_REGION) || echo "⚠️ Image not found or already deleted"

destroy: destroy-local remove-image
	@echo "💣 Destroying CDK stack"
	cd infra && npx cdk destroy --force -c ecrRepo=$(ECR_REPO) -c imageTag=prod-$(IMAGE_TAG)