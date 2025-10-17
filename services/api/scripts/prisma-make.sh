#!/usr/bin/env bash
set -euo pipefail

NAME="${1:-migration}"
TS="$(date +%Y%m%d%H%M%S)"
MIG_DIR="prisma/migrations/${TS}_${NAME}"
SNAP_DIR="prisma/snapshots"
CUR_SCHEMA="prisma/schema.prisma"

mkdir -p "$MIG_DIR" "$SNAP_DIR"

# Find latest snapshot if any
LATEST_SNAP="$(ls -1 ${SNAP_DIR}/*.prisma 2>/dev/null | sort | tail -n1 || true)"

if [ -z "${LATEST_SNAP}" ]; then
  echo "[prisma-make] No snapshot found -> creating initial migration from EMPTY -> schema"
  npx prisma migrate diff \
    --from-empty \
    --to-schema-datamodel "${CUR_SCHEMA}" \
    --script > "${MIG_DIR}/migration.sql"
else
  echo "[prisma-make] Diffing ${LATEST_SNAP} -> ${CUR_SCHEMA}"
  npx prisma migrate diff \
    --from-schema-datamodel "${LATEST_SNAP}" \
    --to-schema-datamodel "${CUR_SCHEMA}" \
    --script > "${MIG_DIR}/migration.sql"
fi

# Create a new snapshot of the current schema for next time
cp "${CUR_SCHEMA}" "${SNAP_DIR}/${TS}_${NAME}.prisma"

# Generate client (no DB needed)
npx prisma generate

echo "[prisma-make] Wrote ${MIG_DIR}/migration.sql"