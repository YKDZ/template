#!/bin/sh
set -eu

database_file=$1
mkdir -p "$(dirname "$database_file")"
DATABASE_FILE="$database_file" pnpm --dir /repo/packages/db run db:prepare:deploy
