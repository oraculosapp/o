import { describe, it, expect } from "vitest";
import { createOpenAiChatModel, ChatModelError } from "../chat-model";

/** Construye una Response SSE falsa como la de OpenAI (stream de deltas). */
function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function delta(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

describe("createOpenAiChatModel", () => {
  it("parsea el stream SSE y emite los deltas de texto", async () => {
    const fetchImpl = async () =>
      sseResponse([delta("Hola"), delta(", "), delta("mundo"), "data: [DONE]\n\n"]);

    const model = createOpenAiChatModel({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });
    const out: string[] = [];
    for await (const t of model.streamChat([{ role: "user", content: "hi" }])) out.push(t);
    expect(out.join("")).toBe("Hola, mundo");
  });

  it("tolera fragmentos SSE partidos entre chunks", async () => {
    const full = delta("parte1") + delta("parte2");
    const mid = Math.floor(full.length / 2);
    const fetchImpl = async () => sseResponse([full.slice(0, mid), full.slice(mid), "data: [DONE]\n\n"]);
    const model = createOpenAiChatModel({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });
    const out: string[] = [];
    for await (const t of model.streamChat([{ role: "user", content: "hi" }])) out.push(t);
    expect(out.join("")).toBe("parte1parte2");
  });

  it("lanza ChatModelError con el status en respuestas no-OK", async () => {
    const fetchImpl = async () => new Response("nope", { status: 429 });
    const model = createOpenAiChatModel({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });
    await expect(async () => {
      for await (const _ of model.streamChat([{ role: "user", content: "hi" }])) void _;
    }).rejects.toMatchObject({ name: "ChatModelError", status: 429 });
  });

  it("complete() devuelve el contenido del mensaje", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "resumen ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const model = createOpenAiChatModel({ apiKey: "k", fetchImpl: fetchImpl as typeof fetch });
    const res = await model.complete([{ role: "user", content: "x" }]);
    expect(res).toBe("resumen ok");
  });

  it("exige apiKey", () => {
    expect(() => createOpenAiChatModel({ apiKey: "" })).toThrow(ChatModelError);
  });
});
