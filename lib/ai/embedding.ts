import { openai, EMBEDDING_MODEL } from "@/lib/ai/openai";
import { getEnv } from "@/lib/env.mjs";
import { sql } from "@/lib/db/db";

type RelevantChunk = {
  id: number;
  content: string;
  createdAt: Date;
  distance: number;
  rerankScore?: number;
};

const DEFAULT_LIMIT = 5;
const FIRST_STAGE_MULTIPLIER = 5;
const FIRST_STAGE_MAX = 50;

type RerankResult = {
  id: number | string;
  content?: string;
  distance?: number;
  rerank_score?: number;
};

async function callReranker(
  query: string,
  candidates: RelevantChunk[],
  limit: number
): Promise<RelevantChunk[] | null> {
  if (candidates.length === 0) {
    return [];
  }

  const env = getEnv();
  const baseUrl = (env.RERANKER_URL || env.PY_BACKEND_URL || "").trim();
  if (!baseUrl) {
    return null;
  }

  let rerankUrl: string;
  try {
    rerankUrl = new URL("/rerank", baseUrl).toString();
  } catch (error) {
    console.error("[embedding] invalid reranker URL", baseUrl, error);
    return null;
  }

  const payload = {
    query,
    top_n: limit,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      content: candidate.content,
      distance: candidate.distance,
    })),
  };

  try {
    const response = await fetch(rerankUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error("[embedding] reranker responded with", response.status, text);
      return null;
    }

    const data = (await response.json()) as { results?: RerankResult[] };
    if (!Array.isArray(data?.results)) {
      return null;
    }

    const baseMap = new Map<string, RelevantChunk>();
    candidates.forEach((candidate) => {
      baseMap.set(String(candidate.id), candidate);
    });

    const merged: RelevantChunk[] = [];
    for (const item of data.results) {
      const base = baseMap.get(String(item.id));
      if (!base) {
        continue;
      }

      merged.push({
        ...base,
        content: item.content ?? base.content,
        distance:
          typeof item.distance === "number" ? item.distance : base.distance,
        rerankScore:
          typeof item.rerank_score === "number" ? item.rerank_score : base.rerankScore,
      });
    }

    if (merged.length === 0) {
      return null;
    }

    merged.sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));
    return merged.slice(0, limit);
  } catch (error) {
    console.error("[embedding] reranker request failed", error);
    return null;
  }
}

export async function findRelevantContent(
  question: string,
  options?: { limit?: number }
): Promise<RelevantChunk[]> {
  const prompt = question.trim();
  if (!prompt) {
    return [];
  }

  const limit = options?.limit ?? DEFAULT_LIMIT;
  const firstStageLimit = Math.min(
    Math.max(limit * FIRST_STAGE_MULTIPLIER, limit),
    FIRST_STAGE_MAX
  );

  const embeddingResponse = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: prompt,
  });

  const embeddingVector = embeddingResponse.data[0]?.embedding;

  if (!embeddingVector || embeddingVector.length === 0) {
    throw new Error("Failed to generate embedding for query");
  }

  const vectorLiteral = `[${embeddingVector.join(",")}]`;

  const rows = await sql<
    {
      id: number;
      content: string;
      created_at: Date;
      distance: number;
    }[]
  >`
    SELECT
      r.id,
      r.content,
      r.created_at,
      e.embedding <-> ${vectorLiteral}::vector AS distance
    FROM embeddings e
    INNER JOIN resources r ON r.id = e.resource_id
    ORDER BY distance ASC
    LIMIT ${firstStageLimit}
  `;

  if (rows.length === 0) {
    return [];
  }

  const baseResults: RelevantChunk[] = rows.map((row) => ({
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
    distance: Number(row.distance ?? 0),
  }));

  const reranked = await callReranker(prompt, baseResults, limit);
  if (reranked && reranked.length > 0) {
    return reranked;
  }

  return baseResults.slice(0, limit);
}
