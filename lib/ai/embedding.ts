import { openai, EMBEDDING_MODEL } from "@/lib/ai/openai";
import { sql } from "@/lib/db/db";

type RelevantChunk = {
  id: number;
  content: string;
  createdAt: Date;
  distance: number;
};

const DEFAULT_LIMIT = 5;

export async function findRelevantContent(
  question: string,
  options?: { limit?: number }
): Promise<RelevantChunk[]> {
  const prompt = question.trim();
  if (!prompt) {
    return [];
  }

  const limit = options?.limit ?? DEFAULT_LIMIT;

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
    LIMIT ${limit}
  `;

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    createdAt: row.created_at,
    distance: Number(row.distance ?? 0),
  }));
}
