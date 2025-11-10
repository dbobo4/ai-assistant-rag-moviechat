import type OpenAI from "openai";
import { NextRequest } from "next/server";

import { createResourceRaw } from "@/lib/actions/resources";
import { findRelevantContent } from "@/lib/ai/embedding";
import { openai, CHAT_MODEL } from "@/lib/ai/openai";
import {
  tools,
  type AddResourceArgs,
  type GetInformationArgs,
} from "@/lib/ai/tools";

const client = openai;

const SYSTEM_PROMPT = `
You are a domain-specialized Film Research Assistant.

MISSION
- Provide accurate, concise answers about films using the tool outputs.
- Keep the conversation moving toward the user’s goal even when information is missing.

TOOLING CONTRACT (STRICT)
- FINAL FACTUAL CONTENT must come ONLY from tool outputs.
- You may call AT MOST ONE tool per user request.
- Never call more than one tool in the same turn (no tool chaining).
- Allowed meta text (not from tools): brief clarifications, next-step guidance, and questions to the user.
- If the user provides film knowledge to store, use addResource.
- If the user asks for film facts (titles, release years, cast/crew, recommendations, techniques), use getInformation.

DEFAULT DECISION TREE (ONE of the following per turn)
1) DIRECT FACT REQUEST (e.g., "What is the release year of 'Inception'?"):
   - Call getInformation with a clean query built from the user text (quote titles; include obvious aliases if supplied).
   - Then produce a final answer grounded ONLY in the returned chunks.

2) MISSING CRITICAL CONTEXT (e.g., ambiguous title, series vs remake, unspecified year/person):
   - Ask exactly ONE targeted clarifying question.
   - Do NOT call a tool in this turn.

3) ZERO/IRRELEVANT RESULTS from getInformation:
   - Do NOT fabricate content.
   - Do NOT end the turn with a dead end.
   - Produce a brief, proactive follow-up that includes:
     • a one-line status (“I couldn’t find this in my current knowledge base.”),
     • exactly ONE targeted question that would unlock a better search (e.g., alternate title, year, director, country),
     • exactly ONE actionable next step (e.g., “If you share a short synopsis or the exact title spelling, I can store it and re-search.”).
   - Example phrasing (adapt to the query): 
     "I couldn’t find this title in my knowledge base. Could you confirm the exact title (any alternate titles or the release year)? If you share a short synopsis, I can save it and try again."

TOOL USAGE POLICY
- addResource: user supplies standalone film knowledge (synopsis, cast info, trivia, production notes) OR user-specific film preferences/experiences to remember.
- getInformation: questions about movies, people, releases, recommendations, production techniques, etc.
- After a tool returns, produce the final user-facing answer strictly from that single tool call’s result.

ANSWERING POLICY
- Never invent or infer facts beyond tool outputs.
- Lead with release year, primary genre, and key cast/creators when available.
- Give short spoiler warnings before plot details unless the user explicitly requests full spoilers.
- Combine information ONLY from chunks returned by the SAME tool call.
- Keep answers concise and factual.

STYLE
- Be direct, practical, and outcome-oriented.
- If you cannot answer yet, ask ONE precise question and offer ONE next step.

FAIL-SAFE
- Only use the old fallback sentence if specifically instructed; otherwise prefer a targeted question + next step when no information is found.
`;


type RawMessage = {
  role?: string;
  parts?: RawPart[];
};

type RawPart = {
  type?: string;
  text?: string;
};

type HistoryMessage = {
  role: string;
  content: string;
};

type MonitoringEventPayload = {
  origin: string;
  model?: string | null;
  totalTokens?: number | null;
  totalLatencyMs?: number | null;
};

function resolveMonitoringEndpoint(req: NextRequest): string | null {
  try {
    return new URL("/api/monitoring", req.nextUrl.origin).toString();
  } catch {
    // fall back to env-provided base URL
  }

  const fallbackBase = process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (fallbackBase) {
    try {
      return new URL("/api/monitoring", fallbackBase).toString();
    } catch {
      // ignore
    }
  }

  return null;
}

async function recordMonitoringEvent(
  endpoint: string | null,
  payload: MonitoringEventPayload
) {
  if (!endpoint) {
    return;
  }

  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        origin: payload.origin,
        model: payload.model ?? undefined,
        totalTokens: payload.totalTokens ?? undefined,
        totalLatencyMs: payload.totalLatencyMs ?? undefined,
      }),
      cache: "no-store",
    });
  } catch (error) {
    console.warn("[chat] monitoring logging failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const rawMessages = Array.isArray((body as any)?.messages)
    ? ((body as any).messages as RawMessage[])
    : [];

  const history: HistoryMessage[] = rawMessages.map((m) => {
    const parts = Array.isArray(m?.parts) ? m.parts : [];
    const content = parts
      .filter(
        (part): part is RawPart & { text: string } =>
          part?.type === "text" && typeof part?.text === "string"
      )
      .map((part) => part.text)
      .join("\n");

    return {
      role: m?.role ?? "user",
      content,
    };
  });

  if (history.length === 0) {
    return new Response("No messages", { status: 400 });
  }

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((m) => ({
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
    })),
  ];

  let toolUsed = false;
  const monitoringEndpoint = resolveMonitoringEndpoint(req);


  for (let step = 0; step < 3; step++) {
    try {
      const apiStart = Date.now();
      const completion = await client.chat.completions.create({
        model: CHAT_MODEL,
        temperature: 0.3,
        messages,
        tools,
        tool_choice: toolUsed ? "none" : "auto",
      });
      await recordMonitoringEvent(monitoringEndpoint, {
        origin: "chat",
        model: completion.model ?? CHAT_MODEL,
        totalTokens: completion.usage?.total_tokens ?? null,
        totalLatencyMs: Date.now() - apiStart,
      });

      const msg = completion.choices[0]?.message;
      if (!msg) {
        break;
      }

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        const text =
        (msg.content && msg.content.trim().length > 0
          ? msg.content
          : "I'm sorry, but I don't have the necessary information to answer that.") ?? "";
      return new Response(text, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
      }

      if (toolUsed) {
      return new Response(
        "Unable to provide additional tool output at this time.",
        {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
        }
      );
      }

    messages.push({
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: msg.tool_calls,
    } as any);

    toolUsed = true;

      for (const call of msg.tool_calls) {
      const name = call.function?.name;
      const rawArgs = call.function?.arguments ?? "{}";

      let result: unknown = null;

      try {
        if (name === "addResource") {
          const args = JSON.parse(rawArgs) as AddResourceArgs;
          const saved = await createResourceRaw({ content: args.content });
          result = { ok: true, saved };
          return new Response("Saved.", {
            status: 200,
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        } else if (name === "getInformation") {
          const args = JSON.parse(rawArgs) as GetInformationArgs;
          const chunks = await findRelevantContent(args.question);
          result = { ok: true, chunks };
        } else {
          result = { ok: false, error: `Unknown tool: ${name}` };
        }
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error ?? "Error");
        console.error("[chat] tool error", { name, message });
        result = { ok: false, error: message };
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      } as any);
    }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? "error");
      console.error("[chat] model call failed", { step, message });
      return new Response(
        "I'm sorry, I'm temporarily unable to answer your request.",
        {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
        }
      );
    }
  }

  return new Response("Unable to produce a final answer.", {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
