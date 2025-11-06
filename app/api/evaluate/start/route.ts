import { NextRequest } from "next/server";

import { getEnv } from "@/lib/env.mjs";

export const runtime = "nodejs";

export async function POST(_req: NextRequest) {
  const env = getEnv();
  const backendUrl = env.PY_BACKEND_URL ?? "http://rag_backend:8000";
  const url = new URL("/evaluate-job", backendUrl).toString();
  console.log("[API/EVAL/START] enqueue", { url });

  const response = await fetch(url, { method: "POST" });
  console.log("[API/EVAL/START] status", { status: response.status });
  if (!response.ok) {
    const text = await response.text().catch(() => "Unknown error");
    console.error("[API/EVAL/START] backend error", { status: response.status, text });
    return new Response(
      JSON.stringify({ error: text || "Unable to start evaluation" }),
      { status: response.status }
    );
  }

  const payload = await response.json();
  const jobId = payload?.job_id ?? payload?.jobId;
  if (!jobId) {
    return new Response(JSON.stringify({ error: "Invalid response from backend" }), {
      status: 500,
    });
  }

  return new Response(JSON.stringify({ jobId }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
