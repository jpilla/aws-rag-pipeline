#!/usr/bin/env bash
set -euo pipefail

# Super simple development script
# Usage: ./scripts/dev.sh [test|setup]

MODE="${1:-setup}"
LOCAL_DB_URL="postgresql://postgres:postgres@localhost:5432/embeddings"

echo "🚀 Fast development workflow..."

# Start database
echo "📦 Starting PostgreSQL database..."
docker-compose up -d postgres

# Wait for database
echo "⏳ Waiting for database..."
until docker-compose exec postgres pg_isready -U postgres -d embeddings >/dev/null 2>&1; do
  sleep 1
done

echo "✅ Database ready!"

# Set DATABASE_URL
export DATABASE_URL="$LOCAL_DB_URL"

if [ "$MODE" = "test" ]; then
  echo "🧪 Testing migrations..."
  npx prisma migrate reset --force --skip-seed
  npx prisma migrate deploy
  npx prisma generate
  echo "✅ Migration test passed!"
else
  echo "📝 Setting up development environment..."
  npx prisma migrate deploy
  npx prisma generate
  echo "✅ Development environment ready!"
fi

echo ""
echo "💡 Next steps:"
echo "   - Run app: docker-compose up"
echo "   - Create migration: make prisma-migrate name"
echo "   - View database: npx prisma studio"
