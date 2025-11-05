import { NextRequest } from "next/server";
import { getEnv } from "@/lib/env.mjs";

// Node runtime (ne Edge!)
export const runtime = "nodejs";

import os from "node:os";
import dns from "node:dns/promises";

function mb(x: number) {
  return Math.round((x / (1024 * 1024)) * 100) / 100;
}

function memSnapshot() {
  const m = process.memoryUsage();
  return {
    rss_mb: mb(m.rss),
    heapTotal_mb: mb(m.heapTotal),
    heapUsed_mb: mb(m.heapUsed),
    external_mb: mb(m.external),
  };
}

export async function POST(_req: NextRequest) {
  const reqId =
    (globalThis.crypto as any)?.randomUUID?.() ??
    Math.random().toString(36).slice(2);

  const started = Date.now();
  const t = () => Date.now() - started;

  const log = (msg: string, data: Record<string, unknown> = {}) => {
    // Mindig JSON-szerű, könnyen grep-elhető
    console.log(
      `[API/EVAL][${reqId}] ${msg}`,
      JSON.stringify({ t_ms: t(), ...data })
    );
  };
  const warn = (msg: string, data: Record<string, unknown> = {}) => {
    console.warn(
      `[API/EVAL][${reqId}] ${msg}`,
      JSON.stringify({ t_ms: t(), ...data })
    );
  };
  const error = (msg: string, data: Record<string, unknown> = {}) => {
    console.error(
      `[API/EVAL][${reqId}] ${msg}`,
      JSON.stringify({ t_ms: t(), ...data })
    );
  };

  log("Route hit", {
    node: process.version,
    pid: process.pid,
    host: os.hostname(),
    mem: memSnapshot(),
  });

  const env = getEnv();
  const backendUrl = env.PY_BACKEND_URL ?? "http://rag_backend:8000";
  const evaluateUrl = new URL("/evaluate-single-turn", backendUrl).toString();

  log("Prepared evaluate URL", { evaluateUrl, backendUrl });

  // DNS feloldás (Docker hálózati anomáliák kirajzolására)
  try {
    const hostname = new URL(backendUrl).hostname;
    const addrs = await dns.lookup(hostname, { all: true });
    log("DNS lookup ok", { hostname, addrs });
  } catch (e: any) {
    warn("DNS lookup failed", { err: e?.message });
  }

  // Timeout finomhangolás env-ből
  const timeoutMs = Number(process.env.EVAL_FETCH_TIMEOUT_MS ?? 1_800_000); // default 30 perc
  const signal = AbortSignal.timeout(timeoutMs);
  signal.addEventListener("abort", () => {
    error("Abort signal fired", { timeoutMs });
  });

  log("Dispatching fetch to backend", { timeoutMs });

  let response: Response | undefined;
  try {
    response = await fetch(evaluateUrl, {
      method: "POST",
      // Korrelációs ID végig piping
      headers: { "X-Request-ID": reqId },
      signal,
    });

    log("TTFB received", {
      status: response.status,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      mem: memSnapshot(),
    });
  } catch (e: any) {
    const isAbort = e?.name === "AbortError";
    error("Fetch threw", {
      name: e?.name,
      message: e?.message,
      stack: e?.stack,
      isAbort,
      mem: memSnapshot(),
    });
    const status = isAbort ? 504 : 502;
    return new Response(
      JSON.stringify({
        error: isAbort ? "Evaluation timed out" : "Evaluation fetch failed",
        reqId,
      }),
      { status, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "Unknown error");
    error("Backend responded non-OK", {
      status: response.status,
      body_preview: text.slice(0, 2000),
    });
    return new Response(
      JSON.stringify({ error: text || "Evaluation request failed", reqId }),
      { status: response.status, headers: { "Content-Type": "application/json" } }
    );
  }

  // OK ág
  let json: any;
  try {
    json = await response.json();
  } catch (e: any) {
    error("Failed to parse backend JSON", { message: e?.message });
    return new Response(
      JSON.stringify({ error: "Invalid JSON from backend", reqId }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  log("Success", {
    total: json?.total,
    accuracy: json?.accuracy,
    relevance_rate: json?.relevance_rate,
    elapsed_ms: t(),
    mem: memSnapshot(),
  });

  return new Response(JSON.stringify({ ...json, reqId }), {
    status: 200,
    headers: { "Content-Type": "application/json", "X-Request-ID": reqId },
  });
}
