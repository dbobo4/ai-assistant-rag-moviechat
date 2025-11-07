import { NextRequest } from "next/server";
import { getEnv } from "@/lib/env.mjs";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const env = getEnv();
  const backendUrl = env.PY_BACKEND_URL ?? "http://rag_backend:8000";

  let body: any = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }

  const type = (typeof body?.type === "string" && body.type) || "single-turn";

  // Single-turn: /evaluate-job   |   RAG-level: /rag-level-job
  const isRag = type === "rag-level";
  const path = isRag ? "/rag-level-job" : "/evaluate-job";
  const url = new URL(path, backendUrl).toString();

  // RAG-hez opcionális paraméterek (limit, top_k)
  const payload = isRag
    ? {
        // a backend mindkét kulcsnevet érti (limit/top_k)
        limit:
          typeof body?.limit === "number"
            ? body.limit
            : typeof body?.sampleSize === "number"
            ? body.sampleSize
            : undefined,
        top_k:
          typeof body?.top_k === "number"
            ? body.top_k
            : typeof body?.topK === "number"
            ? body.topK
            : undefined,
      }
    : undefined;

  console.log("[API/EVAL/START] enqueue", { url, isRag, payload });

  const fetchInit: RequestInit = isRag
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    : { method: "POST" };

  const response = await fetch(url, fetchInit);
  console.log("[API/EVAL/START] status", { status: response.status });

  if (!response.ok) {
    const text = await response.text().catch(() => "Unknown error");
    console.error("[API/EVAL/START] backend error", {
      status: response.status,
      text,
    });
    return new Response(
      JSON.stringify({ error: text || "Unable to start evaluation" }),
      { status: response.status, headers: { "Content-Type": "application/json" } }
    );
  }

  const payloadJson = await response.json().catch(() => ({}));
  const jobId = payloadJson?.job_id ?? payloadJson?.jobId;
  if (!jobId) {
    return new Response(
      JSON.stringify({ error: "Invalid response from backend" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(JSON.stringify({ jobId }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
