#!/bin/sh
set -eu

database_file=$1
mkdir -p "$(dirname "$database_file")"
cd /migration
DATABASE_FILE="$database_file" ./node_modules/.bin/drizzle-kit migrate
