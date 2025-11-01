#!/bin/sh
set -e

if [ "${SKIP_MIGRATIONS}" = "1" ]; then
  echo "Skipping database migrations because SKIP_MIGRATIONS=1"
else
  echo "Running database migrations..."
  npm run db:migrate
fi

exec "$@"
