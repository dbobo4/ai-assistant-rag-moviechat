import { resolve } from "path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { getEnv } from "@/lib/env.mjs";

async function runMigrations() {
  const { DATABASE_URL } = getEnv();
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required to run migrations");
  }
  const connection = postgres(DATABASE_URL, { max: 1 });

  try {
    const db = drizzle(connection);
    const migrationsFolder = resolve(process.cwd(), "drizzle");
    await migrate(db, { migrationsFolder });
    console.log("Database migrations applied.");
  } finally {
    await connection.end({ timeout: 5 });
  }
}

runMigrations().catch((error) => {
  console.error("Failed to run migrations", error);
  process.exitCode = 1;
});
