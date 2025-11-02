#!/bin/sh
set -e

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

wait_for_db_node() {
  echo "Waiting for database via Node client..."
  node - <<'NODE'
    import postgres from "postgres";
    const url = process.env.DATABASE_URL || "postgresql://postgres:postgres@db:5432/app_db";
    const start = Date.now();
    const timeoutMs = 30000;
    const retryMs = 1000;

    (async () => {
      while (Date.now() - start < timeoutMs) {
        try {
          const sql = postgres(url, { connect_timeout: 5000, max: 1 });
          await sql`select 1`;
          await sql.end();
          console.log("DB is ready.");
          process.exit(0);
        } catch (e) {
          await new Promise(r => setTimeout(r, retryMs));
        }
      }
      console.error("DB not reachable within timeout.");
      process.exit(1);
    })();
NODE
}

if [ "${SKIP_MIGRATIONS}" = "1" ]; then
  echo "Skipping database migrations because SKIP_MIGRATIONS=1"
else
  wait_for_db_node
  maybe_init_journal
  echo "Running database migrations..."
  npm run db:migrate
fi

exec "$@"
