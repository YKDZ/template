#!/bin/sh
set -eu

database_file=${DATABASE_FILE:-/data/app.sqlite}
case "$database_file" in
  /*) ;;
  *)
    echo "DATABASE_FILE must be an absolute path: $database_file" >&2
    exit 64
    ;;
esac

prepare_database() {
  mkdir -p "$(dirname "$database_file")"
  DATABASE_FILE="$database_file" drizzle-kit migrate --config /migration/drizzle.config.ts
}

case "${1:-}" in
  prepare-only)
    prepare_database
    ;;
  prepare-and-start)
    prepare_database
    exec node /app/dist/server/index.mjs
    ;;
  *)
    echo "Unsupported container command '${1:-}'. Expected prepare-only or prepare-and-start." >&2
    exit 64
    ;;
esac
