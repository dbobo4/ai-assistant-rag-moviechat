import { createResourceFromChunks } from "@/lib/actions/resources";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const chunks = body?.chunks;

    if (!Array.isArray(chunks) || chunks.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Provide non-empty "chunks" array' }),
        { status: 400 }
      );
    }

    const result = await createResourceFromChunks(chunks);

    return new Response(
      JSON.stringify({
        status: "ok",
        processed: chunks.length,
        ...result,
      }),
      { status: 200 }
    );
  } catch (err: unknown) {
    console.error("upload-chunks error:", err);
    const message = err instanceof Error ? err.message : "Internal error";
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
}
