import OpenAI from "openai";
import { env } from "@/lib/env.mjs";

export const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
});

export const CHAT_MODEL = "gpt-4o-mini";
export const EMBEDDING_MODEL = "text-embedding-3-small";
