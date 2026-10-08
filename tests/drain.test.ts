import test from "node:test";
import assert from "node:assert/strict";
import { drain } from "../src/agent/orchestrator.ts";

/**
 * A space that ends one stream chunk must survive into the next. Found by
 * replaying four conversations in parallel (27/09/2026): Langfuse held
 * "critérios de 2 quartos" as the model wrote it, the database held
 * "critérios de2 quartos", and so did the lead's screen.
 */
function stream(deltas: string[]): string {
  const out: string[] = [];
  let buffer = "";
  for (const delta of deltas) {
    buffer += delta;
    const { ready, rest } = drain(buffer, false);
    out.push(...ready);
    buffer = rest;
  }
  out.push(...drain(buffer, true).ready);
  return out.join(" ");
}

test("a chunk ending in a space does not glue the next chunk onto it", () => {
  assert.equal(
    stream(["Com os critérios de ", "2 quartos, não achei nada. ", "Quer mudar?"]),
    "Com os critérios de 2 quartos, não achei nada. Quer mudar?",
  );
});

test("the three glued replies from the replay come out spaced", () => {
  assert.equal(stream(["Você está procurando ", "2 quartos em Moema."]), "Você está procurando 2 quartos em Moema.");
  assert.equal(stream(["Te mostrei ", "3 opções."]), "Te mostrei 3 opções.");
});

test("a repeated phrase earlier in the buffer does not confuse the carry-over", () => {
  assert.equal(stream(["Oi. Oi ", "de novo."]), "Oi. Oi de novo.");
});

test("a chunk cut inside a number waits for the rest of it (Azure, 08/10)", () => {
  assert.equal(
    stream(["Boa, entendi que é até R$ 6.", "500 🙂 Quantos quartos você precisa?"]),
    "Boa, entendi que é até R$ 6.500 🙂 Quantos quartos você precisa?",
  );
  assert.equal(stream(["Até R$ 1,", "2 milhão. Certo?"]), "Até R$ 1,2 milhão. Certo?");
  assert.equal(stream(["Te mostrei 3.", " Quer ver mais?"]), "Te mostrei 3. Quer ver mais?");
});
