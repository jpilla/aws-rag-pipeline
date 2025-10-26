# 🚀 Fast Development Workflow

This document outlines the fast development workflow for testing Prisma migrations locally without waiting for CDK deployments.

## 🎯 The Problem We Solved

Previously, you had to:
1. Create a migration
2. Deploy the entire CDK stack (slow!)
3. Wait for ECS tasks to spin up
4. If something was wrong, delete the whole stack
5. Wait for the whole stack to be generated again

Now you can test migrations in **seconds** instead of **minutes**!

## 🛠️ Quick Start

### 1. Set up local development environment
```bash
make local-db
```
This will:
- Start a local PostgreSQL database with pgvector support
- Apply all your migrations
- Generate the Prisma client
- Set up everything you need for local development

### 2. Test your migrations (fast feedback!)
```bash
make test-migration
```
This will:
- Reset the database to a clean state
- Apply all migrations
- Test the connection
- Give you immediate feedback if something's wrong

### 3. Create new migrations
```bash
make prisma-migrate your_migration_name
```

### 4. Test the full application locally
```bash
docker-compose up
```

## 🔄 Complete Development Workflow

Here's your new fast development cycle:

1. **Create/modify your Prisma schema** (`prisma/schema.prisma`)
2. **Test locally**: `make test-migration`
3. **Fix any issues** (you get immediate feedback!)
4. **Repeat until working**
5. **Deploy to AWS**: `make deploy-cloud-resources` (only when you're confident!)

## 🗄️ Database Management

### View your database
```bash
npx prisma studio
```

### Reset database
```bash
npx prisma migrate reset --force
```

### Check migration status
```bash
npx prisma migrate status
```

## 🐳 Docker Services

Your `docker-compose.yml` now includes:
- **postgres**: Local PostgreSQL with pgvector support
- **hello**: Your hello service
- **api**: Your API service
- **integration-tests**: Test suite

## 🔧 Environment Variables

The local database uses these defaults:
- `POSTGRES_DB=embeddings`
- `POSTGRES_USER=postgres`
- `POSTGRES_PASSWORD=postgres`
- `POSTGRES_PORT=5432`

You can override them in a `.env` file if needed.

## 🚨 Troubleshooting

### Database won't start
```bash
docker-compose down -v
docker-compose up -d postgres
```

### Migration fails
1. Check your schema syntax
2. Run `make test-migration` to see the exact error
3. Fix the issue and test again

### Port conflicts
If port 5432 is already in use:
```bash
POSTGRES_PORT=5433 make dev-setup
```

## 🎉 Benefits

- **Fast feedback**: Test migrations in seconds, not minutes
- **No AWS costs**: Test locally without spinning up cloud resources
- **Easy debugging**: See exactly what's wrong with your migrations
- **Confident deployments**: Only deploy to AWS when you know it works

## 📝 Next Steps

1. Run `make local-db` to get started
2. Test your current migration with `make test-migration`
3. Make any necessary fixes
4. When ready, deploy with `make deploy-cloud-resources`

Happy coding! 🎉
