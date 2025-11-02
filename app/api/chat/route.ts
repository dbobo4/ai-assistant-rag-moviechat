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

CRITICAL BEHAVIORAL RULES:
- You must NEVER generate, imagine, or invent information on your own.
- You may ONLY respond using content explicitly returned by tools (addResource or getInformation).
- You may call AT MOST ONE tool per user request.
- After receiving a tool result, you MUST produce the final user-facing answer based strictly on that result. 
- Do NOT call any further tools in the same turn.
- If no tool was called or the tool returned no relevant information, respond exactly with:
  "I'm sorry, but I don't have the necessary information to answer that."

TOOL USAGE POLICY:
- If the user provides new standalone film knowledge to store (synopses, cast info, trivia, production notes), call addResource.
- If the user shares personal film preferences or experiences (favorite films, actors, roles, or memorable viewing experiences), treat that as film-domain knowledge about the user and call addResource.
- If the user asks about movies, people in film, release context, recommendations, or production techniques, call getInformation.
- Ask at most one concise clarifying question only when critical context is missing, then call a tool.
- If no tool applies, state clearly that you are a film-focused assistant and encourage film-related questions.

ANSWERING POLICY:
- Always base your final answer solely and directly on the tool result.
- Do not introduce or rephrase information that was not returned by a tool.
- Lead with release year, primary genre, and key cast or creators before deeper detail (when available in the tool data).
- Provide short spoiler warnings when discussing plot points unless the user explicitly requests full spoilers.
- Combine information only from chunks returned by the same tool call.
- Keep answers concise, factual, and fully grounded in the tool output.
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

  for (let step = 0; step < 3; step++) {
    try {
      console.log("[chat] step", step, {
        toolUsed,
        historyCount: history.length,
      });

      const completion = await client.chat.completions.create({
        model: CHAT_MODEL,
        temperature: 0.3,
        messages,
        tools,
        tool_choice: toolUsed ? "none" : "auto",
      });

      const msg = completion.choices[0]?.message;
      if (!msg) {
        console.log("[chat] no message returned from model");
        break;
      }

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        const preview = (msg.content ?? "").slice(0, 120);
        console.log("[chat] model returned final text", { length: (msg.content ?? "").length, preview });
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
        console.log("[chat] model attempted another tool after first", {
          toolCalls: msg.tool_calls?.map((t) => t.function?.name),
        });
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
          console.log("[chat] tool:addResource", {
            contentPreview: (args?.content ?? "").slice(0, 80),
            length: (args?.content ?? "").length,
          });
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
          console.log("[chat] tool:getInformation", {
            questionPreview: (args?.question ?? "").slice(0, 80),
            length: (args?.question ?? "").length,
          });
          const chunks = await findRelevantContent(args.question);
          console.log("[chat] retrieved chunks", { count: chunks.length });
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
