import { NextRequest } from "next/server";
import { sql } from "@/lib/db/db";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 20;

function createLogger(reqId: string, started: number) {
  const elapsed = () => Date.now() - started;
  const fmt = (level: "log" | "warn" | "error") => {
    return (msg: string, data: Record<string, unknown> = {}) => {
      console[level](
        `[API/RAG_SAMPLES][${reqId}] ${msg}`,
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

  const limitRaw = payload?.limit ?? DEFAULT_LIMIT;
  const limit = Number(limitRaw);
  if (!Number.isFinite(limit) || limit <= 0) {
    warn("Invalid limit received", { limitRaw });
    return new Response(
      JSON.stringify({ error: "limit must be a positive number", reqId }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    log("Querying random samples", { limit });
    const rows = await sql<
      { id: number; content: string | null; created_at: Date }[]
    >`
      SELECT r.id, r.content, r.created_at
      FROM resources r
      INNER JOIN embeddings e ON e.resource_id = r.id
      ORDER BY random()
      LIMIT ${limit}
    `;

    const items = rows.map((row) => ({
      id: row.id,
      text: row.content ?? "",
      metadata: { chunk_index: row.id },
    }));

    return new Response(JSON.stringify({ items, reqId }), {
      status: 200,
      headers: { "Content-Type": "application/json", "X-Request-ID": reqId },
    });
  } catch (err: any) {
    error("Database query failed", { message: err?.message });
    return new Response(
      JSON.stringify({ error: "Failed to fetch samples", reqId }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
