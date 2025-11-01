import { promises as fs } from "fs";
import path from "path";

import { getEnv } from "@/lib/env.mjs";

export const runtime = "nodejs";

const env = getEnv();
const MOVIE_DATA_DIR =
  env.MOVIE_DATA_DIR && env.MOVIE_DATA_DIR.trim().length > 0
    ? env.MOVIE_DATA_DIR
    : path.join(process.cwd(), "movie_data");
const UPLOADER_URL =
  env.UPLOADER_URL && env.UPLOADER_URL.trim().length > 0
    ? env.UPLOADER_URL
    : "http://uploader:8000";

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return new Response(JSON.stringify({ error: "No file provided" }), {
        status: 400,
      });
    }

    await fs.mkdir(MOVIE_DATA_DIR, { recursive: true });

    const filePath = path.join(MOVIE_DATA_DIR, file.name);
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    await fs.writeFile(filePath, bytes);

    const processUrl = new URL("/process-file", UPLOADER_URL).toString();
    const triggerResponse = await fetch(processUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: file.name }),
    });

    const triggerJson = await triggerResponse.json().catch(() => ({}));
    if (!triggerResponse.ok) {
      return new Response(
        JSON.stringify({
          error: triggerJson?.error ?? "Failed to trigger processing",
        }),
        { status: triggerResponse.status }
      );
    }

    const processed = Array.isArray(triggerJson?.processed_chunks)
      ? triggerJson.processed_chunks.length
      : triggerJson?.processed ?? 0;

    return new Response(
      JSON.stringify({
        status: "saved+processed",
        filename: file.name,
        processed,
      }),
      { status: 200 }
    );
  } catch (error: unknown) {
    console.error("Upload route error:", error);
    const message =
      error instanceof Error ? error.message : "Internal upload error";
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
}
