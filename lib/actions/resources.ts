import { openai, EMBEDDING_MODEL } from "@/lib/ai/openai";
import { db } from "@/lib/db/db";
import { embeddings, resources } from "@/lib/db/schema";

type MonitoringPayload = {
  origin: string;
  model?: string | null;
  totalTokens?: number | null;
  totalLatencyMs?: number | null;
};

function resolveMonitoringEndpoint(): string | null {
  const explicit = process.env.MONITORING_ENDPOINT;
  if (explicit) {
    try {
      return new URL("/api/monitoring", explicit).toString();
    } catch (error) {
      console.warn("[resources] invalid MONITORING_ENDPOINT", error);
    }
  }

  const fallback =
    process.env.APP_BASE_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000";

  try {
    return new URL("/api/monitoring", fallback).toString();
  } catch (error) {
    console.warn("[resources] failed to resolve monitoring endpoint", error);
    return null;
  }
}

const monitoringEndpoint = resolveMonitoringEndpoint();

async function recordMonitoringEvent(payload: MonitoringPayload) {
  if (!monitoringEndpoint) {
    return;
  }

  try {
    await fetch(monitoringEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        origin: payload.origin,
        model: payload.model ?? undefined,
        totalTokens: payload.totalTokens ?? undefined,
        totalLatencyMs: payload.totalLatencyMs ?? undefined,
      }),
    });
  } catch (error) {
    console.warn("[resources] monitoring logging failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

type CreateResourceArgs = {
  content: string;
};

export async function createResourceRaw({ content }: CreateResourceArgs) {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Content is required to create a resource");
  }

  const embeddingStart = Date.now();
  const embeddingResponse = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: trimmed,
  });
  const elapsedMs = Date.now() - embeddingStart;

  const embeddingVector = embeddingResponse.data[0]?.embedding;

  if (!embeddingVector || embeddingVector.length === 0) {
    throw new Error("Failed to generate embedding for resource");
  }

  const totalTokens =
    typeof embeddingResponse?.usage?.total_tokens === "number"
      ? embeddingResponse.usage.total_tokens
      : null;
  void recordMonitoringEvent({
    origin: "upload",
    model: EMBEDDING_MODEL,
    totalTokens,
    totalLatencyMs: elapsedMs,
  });

  const [resource] = await db
    .insert(resources)
    .values({ content: trimmed })
    .returning({
      id: resources.id,
      content: resources.content,
      createdAt: resources.createdAt,
    });

  if (!resource) {
    throw new Error("Failed to insert resource");
  }

  await db.insert(embeddings).values({
    resourceId: resource.id,
    embedding: embeddingVector,
  });

  return resource;
}

export async function createResourceFromChunks(chunks: string[]) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error("At least one chunk is required to create resources");
  }

  const created = [];
  for (const chunk of chunks) {
    const resource = await createResourceRaw({ content: chunk });
    created.push(resource);
  }

  return {
    message: `Created ${created.length} resources from chunks`,
    resources: created,
  };
}
