import { streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { modelCall } from "../src/agent/provider.ts";

const calls: unknown[] = [];

const started = Date.now();
const result = streamText({
  ...modelCall(),
  stopWhen: stepCountIs(3),
  system:
    "Você é uma corretora de imóveis. Extraia o que o lead disse chamando a tool updateSlots, depois responda em uma frase curta em português.",
  messages: [{ role: "user", content: "Estou procurando apartamento na zona sul para comprar" }],
  tools: {
    updateSlots: tool({
      description: "Registra o que o lead disse.",
      inputSchema: z.object({
        intent: z.enum(["purchase", "rental", "investment"]).nullable(),
        neighborhoods: z.array(z.string()).nullable(),
      }),
      execute: (input) => {
        calls.push(input);
        return { ok: true };
      },
    }),
  },
});

let text = "";
for await (const part of result.fullStream) {
  if (part.type === "text-delta") text += part.text;
  if (part.type === "tool-call") console.log("TOOL CALL", part.toolName, JSON.stringify(part.input));
  if (part.type === "error") console.log("ERROR", part.error);
}
console.log("TEXT:", JSON.stringify(text));
console.log("CALLS:", JSON.stringify(calls));
console.log(`${Date.now() - started} ms`);
