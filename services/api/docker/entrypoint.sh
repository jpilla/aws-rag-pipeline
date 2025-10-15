#!/usr/bin/env sh
set -eu

# This script blocks until Prisma migrations succeed, then execs the API.
exec node dist/db/prisma-start.js