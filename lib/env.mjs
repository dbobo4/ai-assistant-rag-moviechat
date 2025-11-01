import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
      "DATABASE_URL must be a valid postgres connection string"
    ),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  NODE_ENV: z.enum(["development", "test", "production"]).optional(),
});

const rawEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  NODE_ENV: process.env.NODE_ENV,
};

const skipValidation = process.env.SKIP_ENV_VALIDATION === "true";

const env = (() => {
  if (skipValidation) {
    return rawEnv;
  }

  const parsed = envSchema.safeParse(rawEnv);
  if (!parsed.success) {
    throw parsed.error;
  }

  return parsed.data;
})();

/**
 * When validation is skipped the values might technically be undefined,
 * but we trust the runtime and cast to the schema type for convenience.
 */
const getEnv = () => env;

export { env, getEnv };
