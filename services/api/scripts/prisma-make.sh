#!/usr/bin/env bash
set -euo pipefail

NAME="${1:-migration}"               # usage: npm run prisma:make add-embeddings
TS="$(date +%Y%m%d%H%M%S)"
DIR="prisma/migrations/${TS}_${NAME}"
mkdir -p "$DIR"

# If there are existing migrations, diff from them; otherwise diff from empty
if [ -d "prisma/migrations" ] && [ -n "$(ls -A prisma/migrations || true)" ]; then
  npx prisma migrate diff \
    --from-migrations \
    --to-schema-datamodel prisma/schema.prisma \
    --script > "${DIR}/migration.sql"
else
  npx prisma migrate diff \
    --from-empty \
    --to-schema-datamodel prisma/schema.prisma \
    --script > "${DIR}/migration.sql"
fi

# Generate client (no DB needed)
npx prisma generate

echo "Created ${DIR}/migration.sql"