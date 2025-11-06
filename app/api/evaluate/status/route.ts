import { NextRequest } from "next/server";

import { getEnv } from "@/lib/env.mjs";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) {
    return new Response(JSON.stringify({ error: "Missing jobId" }), { status: 400 });
  }

  const env = getEnv();
  const backendUrl = env.PY_BACKEND_URL ?? "http://rag_backend:8000";
  const url = new URL(`/evaluate-job/${jobId}`, backendUrl).toString();
  console.log("[API/EVAL/STATUS] fetch", { url });

  const response = await fetch(url, { method: "GET" });
  console.log("[API/EVAL/STATUS] status", { status: response.status });
  if (!response.ok) {
    const text = await response.text().catch(() => "Unknown error");
    console.error("[API/EVAL/STATUS] backend error", { status: response.status, text });
    return new Response(
      JSON.stringify({ error: text || "Unable to fetch job status" }),
      { status: response.status }
    );
  }

  const payload = await response.json();
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
