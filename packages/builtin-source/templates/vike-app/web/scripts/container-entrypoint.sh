#!/bin/sh
set -eu

database_file=${DATABASE_FILE:-/data/app.sqlite}
container_capability=${CONTAINER_CAPABILITY:-prepare-and-start}
prepare_database_command=${PREPARE_DATABASE_COMMAND:-/usr/local/bin/prepare-database}
case "$database_file" in
  /*) ;;
  *)
    echo "DATABASE_FILE must be an absolute path: $database_file" >&2
    exit 64
    ;;
esac

prepare_database() {
  "$prepare_database_command" "$database_file"
}

if [ "$container_capability" = "start-only" ]; then
  case "${1:-}" in
    start-only)
      exec node /app/dist/server/index.mjs
      ;;
    prepare-only | prepare-and-start)
      echo "Container capability 'start-only' does not support '${1}'." >&2
      exit 64
      ;;
    *)
      echo "Unsupported container command '${1:-}'. Expected start-only." >&2
      exit 64
      ;;
  esac
fi

if [ "$container_capability" != "prepare-and-start" ]; then
  echo "Unsupported CONTAINER_CAPABILITY '$container_capability'." >&2
  exit 64
fi

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
