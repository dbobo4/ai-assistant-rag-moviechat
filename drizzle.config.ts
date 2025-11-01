import { defineConfig } from "drizzle-kit";

const DEFAULT_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/app_db";

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: DEFAULT_DATABASE_URL,
  },
  verbose: true,
  strict: true,
});
