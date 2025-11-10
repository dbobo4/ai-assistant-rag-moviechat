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
  const isRag = type === "rag-level";
  const isUserSat = type === "user-satisfaction";
  const rawFileCount =
    typeof body?.fileCount === "number"
      ? body.fileCount
      : typeof body?.file_limit === "number"
      ? body.file_limit
      : undefined;
  const fileCount =
    rawFileCount !== undefined && Number.isFinite(rawFileCount)
      ? Math.max(1, Math.floor(rawFileCount))
      : undefined;

  const path = isRag
    ? "/rag-level-job"
    : isUserSat
    ? "/user-satisfaction-job"
    : "/evaluate-job";
  const url = new URL(path, backendUrl).toString();

  let payload: any = undefined;
  if (isRag) {
    payload = {
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
    };
  } else if (isUserSat) {
    payload = {
      persona_id: body?.persona_id ?? body?.personaId ?? "clarification_cooperative",
      goal_id: body?.goal_id ?? body?.goalId ?? "specific-memory-recall",
      turns:
        typeof body?.turns === "number" ? body.turns : typeof body?.turnCount === "number" ? body.turnCount : 4,
    };
  } else if (fileCount !== undefined) {
    payload = { file_limit: fileCount };
  }

  console.log("[API/EVAL/START] enqueue", { url, type, payload });

  const fetchInit: RequestInit = payload
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
