#!/bin/sh
set -e

HOST=${DATABASE_HOST:-db}
PORT=${DATABASE_PORT:-5432}

wait_for_db() {
  echo "Waiting for database at ${HOST}:${PORT}..."
  while ! nc -z "$HOST" "$PORT" >/dev/null 2>&1; do
    sleep 1
  done
}

maybe_init_journal() {
  if [ ! -f "./drizzle/meta/_journal.json" ]; then
    echo "Initializing drizzle journal metadata..."
    mkdir -p ./drizzle/meta
    cat <<'EOF' > ./drizzle/meta/_journal.json
{
  "version": "5",
  "dialect": "pg",
  "entries": [
    {
      "idx": 0,
      "version": "0000",
      "when": 0,
      "tag": "0000_init",
      "breakpoints": false
    }
  ]
}
EOF
  fi
}

if [ "${SKIP_MIGRATIONS}" = "1" ]; then
  echo "Skipping database migrations because SKIP_MIGRATIONS=1"
else
  wait_for_db
  maybe_init_journal
  echo "Running database migrations..."
  npm run db:migrate
fi

exec "$@"
