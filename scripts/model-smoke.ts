import { generateText } from "ai";
import { modelCall } from "../src/agent/provider.ts";

/**
 * One real call through `agent/provider.ts`, to prove the factory works against
 * whatever `PROVIDER_BASE_URL` and `MODEL_ID` currently point at:
 *
 *   docker compose exec app node scripts/model-smoke.ts
 *
 * Not a test — the unit suite must never need a model. Set `MODEL_THINKING=true`
 * in `.env` and run it again to check the body injection end to end.
 */

const started = Date.now();
const result = await generateText({
  ...modelCall(),
  prompt: "Em uma frase curta e em português, o que faz um corretor de imóveis?",
});

console.log(result.text.trim() === "" ? "(empty text)" : result.text.trim());
console.log(`reasoning: ${result.reasoningText?.length ?? 0} chars`);
console.log(`${Date.now() - started} ms · ${result.usage.outputTokens ?? "?"} output tokens`);
