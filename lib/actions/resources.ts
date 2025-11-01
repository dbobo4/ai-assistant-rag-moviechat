import { openai, EMBEDDING_MODEL } from "@/lib/ai/openai";
import { db } from "@/lib/db/db";
import { embeddings, resources } from "@/lib/db/schema";

type CreateResourceArgs = {
  content: string;
};

export async function createResourceRaw({ content }: CreateResourceArgs) {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Content is required to create a resource");
  }

  const embeddingResponse = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: trimmed,
  });

  const embeddingVector = embeddingResponse.data[0]?.embedding;

  if (!embeddingVector || embeddingVector.length === 0) {
    throw new Error("Failed to generate embedding for resource");
  }

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
