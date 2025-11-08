import { NextRequest } from "next/server";
import { getEnv } from "@/lib/env.mjs";

export const runtime = "nodejs";

// Állapot-prioritás (melyik “előrébb tart”)
const STATE_RANK: Record<string, number> = {
  SUCCESS: 5,
  FAILURE: 4,
  PROGRESS: 3,
  STARTED: 2,
  RETRY: 2,
  PENDING: 1,
};

async function fetchStatus(url: string) {
  const res = await fetch(url, { method: "GET" });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // hagyjuk null-on
  }
  return { ok: res.ok, status: res.status, text, json };
}

function betterOf(a: any | null, b: any | null) {
  // Ha csak az egyik érvényes, azt visszük tovább
  if (a && !b) return a;
  if (!a && b) return b;
  if (!a && !b) return null;

  const sa = (a?.status || "").toUpperCase();
  const sb = (b?.status || "").toUpperCase();
  const ra = STATE_RANK[sa] ?? 0;
  const rb = STATE_RANK[sb] ?? 0;

  // Nagyobb rank a nyerő
  if (ra > rb) return a;
  if (rb > ra) return b;

  // Azonos ranknál mindegy, vigyük az elsőt
  return a;
}

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) {
    return new Response(JSON.stringify({ error: "Missing jobId" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const env = getEnv();
  const backendUrl = env.PY_BACKEND_URL ?? "http://rag_backend:8000";

  // Mindkét backend státuszt lekérdezzük:
  const stUrl = new URL(`/evaluate-job/${jobId}`, backendUrl).toString();
  const ragUrl = new URL(`/rag-level-job/${jobId}`, backendUrl).toString();
  const userUrl = new URL(`/user-satisfaction-job/${jobId}`, backendUrl).toString();

  console.log("[API/EVAL/STATUS] fetch all", { stUrl, ragUrl, userUrl });

  const [st, rag, user] = await Promise.all([
    fetchStatus(stUrl),
    fetchStatus(ragUrl),
    fetchStatus(userUrl),
  ]);

  if (!st.ok && !rag.ok && !user.ok) {
    return new Response(
      JSON.stringify({
        error:
          (st.text && `Single-turn error: ${st.text}`) ||
          (rag.text && `RAG error: ${rag.text}`) ||
          (user.text && `User satisfaction error: ${user.text}`) ||
          "Unable to fetch job status",
      }),
      {
        status: Math.max(st.status, rag.status, user.status),
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const chosen =
    [st.json, rag.json, user.json].reduce((acc, cur) => betterOf(acc, cur), null) ||
    st.json ||
    rag.json ||
    user.json;

  return new Response(JSON.stringify(chosen ?? { status: "PENDING" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
