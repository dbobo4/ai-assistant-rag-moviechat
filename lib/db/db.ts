import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getEnv } from "@/lib/env.mjs";

const { DATABASE_URL } = getEnv();

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is not defined");
}

const connection = postgres(DATABASE_URL, {
  prepare: false,
  max: Number(process.env.POSTGRES_POOL_MAX ?? 10),
});

export const db = drizzle(connection);
export const sql = connection;
