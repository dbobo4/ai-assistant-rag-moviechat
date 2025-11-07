import { NextRequest } from "next/server";
import { findRelevantContent } from "@/lib/ai/embedding";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 5;

function createLogger(reqId: string, started: number) {
  const elapsed = () => Date.now() - started;
  const fmt = (level: "log" | "warn" | "error") => {
    return (msg: string, data: Record<string, unknown> = {}) => {
      console[level](
        `[API/RAG_RETRIEVER][${reqId}] ${msg}`,
        JSON.stringify({ t_ms: elapsed(), ...data })
      );
    };
  };
  return {
    log: fmt("log"),
    warn: fmt("warn"),
    error: fmt("error"),
  };
}

export async function POST(req: NextRequest) {
  const reqId =
    (globalThis.crypto as any)?.randomUUID?.() ??
    Math.random().toString(36).slice(2);
  const started = Date.now();
  const { log, warn, error } = createLogger(reqId, started);

  let payload: any = null;
  try {
    payload = await req.json();
  } catch {
    payload = null;
  }

  const question = typeof payload?.question === "string" ? payload.question.trim() : "";
  if (!question) {
    warn("Missing question");
    return new Response(
      JSON.stringify({ error: "question is required", reqId }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const limit = Number(payload?.limit ?? DEFAULT_LIMIT);
  if (!Number.isFinite(limit) || limit <= 0) {
    warn("Invalid limit", { limitRaw: payload?.limit });
    return new Response(
      JSON.stringify({ error: "limit must be a positive number", reqId }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    log("Calling findRelevantContent", { limit });
    const chunks = await findRelevantContent(question, { limit });
    const results = chunks.map((chunk) => ({
      id: chunk.id,
      content: chunk.content,
      distance: chunk.distance,
      rerankScore: chunk.rerankScore,
      metadata: { chunk_index: chunk.id },
    }));

    return new Response(JSON.stringify({ results, reqId }), {
      status: 200,
      headers: { "Content-Type": "application/json", "X-Request-ID": reqId },
    });
  } catch (err: any) {
    error("findRelevantContent failed", { message: err?.message });
    return new Response(
      JSON.stringify({ error: "Retriever query failed", reqId }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
