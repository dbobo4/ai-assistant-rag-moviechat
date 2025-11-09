import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";
import { vector } from "./customTypes";

export const resources = pgTable("resources", {
  id: serial("id").primaryKey(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const embeddings = pgTable("embeddings", {
  id: serial("id").primaryKey(),
  resourceId: integer("resource_id")
    .notNull()
    .references(() => resources.id, { onDelete: "cascade" }),
  embedding: vector("embedding", { dimensions: 1536 }).notNull(),
});

export const monitoring = pgTable("monitoring", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  origin: text("origin").notNull(),
  model: text("model"),
  totalTokens: integer("total_tokens"),
  totalLatencyMs: integer("total_latency_ms"),
});

