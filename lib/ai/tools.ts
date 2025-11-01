import type OpenAI from "openai";

export const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "addResource",
      description:
        "Add a resource (raw text) to the film knowledge base. Use when the user provides new information about movies, directors, actors, or trivia that should be stored.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The film-related content or resource to store verbatim.",
          },
        },
        required: ["content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getInformation",
      description:
        "Query the knowledge base for relevant film knowledge chunks to answer the user.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "The user's question; include film title, people involved, release year, or genre if applicable.",
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
  },
];

export type AddResourceArgs = { content: string };
export type GetInformationArgs = { question: string };
