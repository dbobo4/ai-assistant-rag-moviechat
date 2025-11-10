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

export async function POST(req: NextRequest) {
  const reqId =
    (globalThis.crypto as any)?.randomUUID?.() ??
    Math.random().toString(36).slice(2);

  const started = Date.now();
  const t = () => Date.now() - started;

  const log = (msg: string, data: Record<string, unknown> = {}) => {
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

  let body: any = null;
  try {
    body = (await req.json()) ?? null;
  } catch {
    body = null;
  }

  const env = getEnv();

  const evalType =
    (typeof body?.type === "string" && body.type) || "single-turn";
  const limit =
    typeof body?.limit === "number"
      ? body.limit
      : typeof body?.sampleSize === "number"
      ? body.sampleSize
      : undefined;
  const topK =
    typeof body?.topK === "number"
      ? body.topK
      : typeof body?.top_k === "number"
      ? body.top_k
      : undefined;

  const personaId =
    typeof body?.persona_id === "string"
      ? body.persona_id
      : typeof body?.personaId === "string"
      ? body.personaId
      : "clarification_cooperative";
  const goalId =
    typeof body?.goal_id === "string"
      ? body.goal_id
      : typeof body?.goalId === "string"
      ? body.goalId
      : "specific-memory-recall";
  const turns =
    typeof body?.turns === "number"
      ? body.turns
      : typeof body?.turnCount === "number"
      ? body.turnCount
      : 4;
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

  const backendUrl = env.PY_BACKEND_URL ?? "http://rag_backend:8000";

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

  if (evalType === "rag-level") {
    // RAG: CELERY JOB indítás → { jobId }-t adunk vissza a UI-nak
    const startUrl = new URL("/rag-level-job", backendUrl).toString();
    log("Dispatching RAG job start", {
      startUrl,
      backendUrl,
      limit,
      topK,
      timeoutMs,
    });

    let startResp: Response;
    try {
      startResp = await fetch(startUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-ID": reqId,
        },
        // Küldjük a paramétereket; az undefined mezőket a JSON nem fogja beírni
        body: JSON.stringify({ limit, top_k: topK }),
        signal,
      });
    } catch (e: any) {
      const isAbort = e?.name === "AbortError";
      error("RAG job start threw", {
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

    if (!startResp.ok) {
      const text = await startResp.text().catch(() => "Unknown error");
      error("Backend responded non-OK for RAG job start", {
        status: startResp.status,
        body_preview: text.slice(0, 2000),
      });
      return new Response(
        JSON.stringify({ error: text || "RAG job start failed", reqId }),
        {
          status: startResp.status,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const startJson = await startResp.json().catch(() => null);
    const jobId = startJson?.job_id || startJson?.jobId;
    if (!jobId) {
      error("No job_id returned by backend on RAG job start");
      return new Response(
        JSON.stringify({ error: "No job_id from backend", reqId }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    log("RAG job started", { jobId, elapsed_ms: t(), mem: memSnapshot() });
    return new Response(JSON.stringify({ jobId, reqId }), {
      status: 200,
      headers: { "Content-Type": "application/json", "X-Request-ID": reqId },
    });
  }

  if (evalType === "user-satisfaction") {
    const startUrl = new URL("/user-satisfaction-job", backendUrl).toString();
    log("Dispatching user satisfaction job start", {
      startUrl,
      backendUrl,
      personaId,
      goalId,
      turns,
      timeoutMs,
    });

    let startResp: Response;
    try {
      startResp = await fetch(startUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-ID": reqId,
        },
        body: JSON.stringify({
          persona_id: personaId,
          goal_id: goalId,
          turns,
        }),
        signal,
      });
    } catch (e: any) {
      const isAbort = e?.name === "AbortError";
      error("User satisfaction job start threw", {
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

    if (!startResp.ok) {
      const text = await startResp.text().catch(() => "Unknown error");
      error("Backend responded non-OK for user satisfaction job start", {
        status: startResp.status,
        body_preview: text.slice(0, 2000),
      });
      return new Response(
        JSON.stringify({ error: text || "User satisfaction job start failed", reqId }),
        {
          status: startResp.status,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const startJson = await startResp.json().catch(() => null);
    const jobId = startJson?.job_id || startJson?.jobId;
    if (!jobId) {
      error("No job_id returned by backend on user satisfaction job start");
      return new Response(
        JSON.stringify({ error: "No job_id from backend", reqId }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    log("User satisfaction job started", { jobId, elapsed_ms: t(), mem: memSnapshot() });
    return new Response(JSON.stringify({ jobId, reqId }), {
      status: 200,
      headers: { "Content-Type": "application/json", "X-Request-ID": reqId },
    });
  }

  let endpoint = "/evaluate-single-turn";
  if (evalType === "user-satisfaction") {
    endpoint = "/evaluate-user-satisfaction";
  }

  const evaluateUrl = new URL(endpoint, backendUrl).toString();
  log("Dispatching single-turn evaluate", {
    evaluateUrl,
    backendUrl,
    timeoutMs,
    fileCount: fileCount ?? null,
  });

  let response: Response | undefined;
  try {
    const singleTurnPayload =
      fileCount !== undefined ? { file_limit: fileCount } : undefined;
    const headers: Record<string, string> = singleTurnPayload
      ? { "X-Request-ID": reqId, "Content-Type": "application/json" }
      : { "X-Request-ID": reqId };
    const bodyPayload = singleTurnPayload
      ? JSON.stringify(singleTurnPayload)
      : undefined;
    response = await fetch(evaluateUrl, {
      method: "POST",
      headers,
      body: bodyPayload,
      signal,
    });

    log("TTFB received (single-turn)", {
      status: response.status,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      mem: memSnapshot(),
    });
  } catch (e: any) {
    const isAbort = e?.name === "AbortError";
    error("Fetch threw (single-turn)", {
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
    error("Backend responded non-OK (single-turn)", {
      status: response.status,
      body_preview: text.slice(0, 2000),
    });
    return new Response(
      JSON.stringify({ error: text || "Evaluation request failed", reqId }),
      { status: response.status, headers: { "Content-Type": "application/json" } }
    );
  }

  let json: any;
  try {
    json = await response.json();
  } catch (e: any) {
    error("Failed to parse backend JSON (single-turn)", { message: e?.message });
    return new Response(
      JSON.stringify({ error: "Invalid JSON from backend", reqId }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  log("Success (single-turn)", {
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

export async function GET(req: NextRequest) {
  const reqId =
    (globalThis.crypto as any)?.randomUUID?.() ??
    Math.random().toString(36).slice(2);
  const started = Date.now();
  const t = () => Date.now() - started;
  const log = (msg: string, data: Record<string, unknown> = {}) =>
    console.log(
      `[API/EVAL][${reqId}] ${msg}`,
      JSON.stringify({ t_ms: t(), ...data })
    );
  const error = (msg: string, data: Record<string, unknown> = {}) =>
    console.error(
      `[API/EVAL][${reqId}] ${msg}`,
      JSON.stringify({ t_ms: t(), ...data })
    );

  const env = getEnv();
  const backendUrl = env.PY_BACKEND_URL ?? "http://rag_backend:8000";

  const personasUrl = new URL(
    "/user-satisfaction/personas",
    backendUrl
  ).toString();
  const goalsUrl = new URL("/user-satisfaction/goals", backendUrl).toString();

  try {
    const [personasResp, goalsResp] = await Promise.all([
      fetch(personasUrl),
      fetch(goalsUrl),
    ]);

    if (!personasResp.ok) {
      const text = await personasResp.text();
      throw new Error(
        `Personas endpoint failed (${personasResp.status}): ${text}`
      );
    }
    if (!goalsResp.ok) {
      const text = await goalsResp.text();
      throw new Error(`Goals endpoint failed (${goalsResp.status}): ${text}`);
    }

    const personasJson = await personasResp.json();
    const goalsJson = await goalsResp.json();

    log("Fetched user satisfaction metadata");
    return new Response(
      JSON.stringify({
        personas: personasJson?.personas ?? [],
        goals: goalsJson?.goals ?? [],
        reqId,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (e: any) {
    error("Failed to fetch metadata", { message: e?.message });
    return new Response(
      JSON.stringify({ error: e?.message || "Failed to fetch metadata", reqId }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
}
