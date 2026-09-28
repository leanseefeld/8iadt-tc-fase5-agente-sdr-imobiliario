import { streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { modelCall } from "../src/agent/provider.ts";

/**
 * One trivial tool call, or N of them at once.
 *
 *   node scripts/tool-smoke.ts
 *   node scripts/tool-smoke.ts --concurrency 1
 *   node scripts/tool-smoke.ts --concurrency 4
 *
 * Run the two measurements serially. Running them at the same time measures
 * neither. Per-request latency at N=4 near 4× N=1 means the server queues.
 */

const flag = process.argv.indexOf("--concurrency");
const concurrency = flag === -1 ? 1 : Number(process.argv[flag + 1]);
if (!Number.isInteger(concurrency) || concurrency < 1) {
  console.error("concurrency must be a positive integer");
  process.exit(1);
}

async function once(index: number): Promise<number> {
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
        execute: () => ({ ok: true }),
      }),
    },
  });

  let text = "";
  let toolCalls = 0;
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") text += part.text;
    if (part.type === "tool-call") toolCalls += 1;
    if (part.type === "error") console.log("ERROR", index, part.error);
  }
  const elapsed = Date.now() - started;
  console.log(`request ${index}: ${elapsed} ms, tools ${toolCalls}, text ${JSON.stringify(text)}`);
  return elapsed;
}

const started = Date.now();
const latencies = await Promise.all(Array.from({ length: concurrency }, (_, index) => once(index + 1)));
const perRequest = latencies.reduce((sum, value) => sum + value, 0) / latencies.length;
console.log(
  `concurrency ${concurrency}: wall ${Date.now() - started} ms, per-request avg ${Math.round(perRequest)} ms, ` +
    `min ${Math.min(...latencies)} ms, max ${Math.max(...latencies)} ms`,
);
