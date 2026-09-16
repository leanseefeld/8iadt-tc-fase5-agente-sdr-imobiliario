import test from "node:test";
import assert from "node:assert/strict";
import {
  splitSentences,
  createReplyGuard,
  checkReply,
  type GuardContext,
  type GuardVerdict,
  type GuardName,
} from "../src/domain/reply-guards.ts";

/** No DB, no model — pure functions over the reply text, per FR-012. */

function context(overrides: Partial<GuardContext> = {}): GuardContext {
  return { pendingSlot: null, nextSlot: null, allowedAmounts: [], allowedPercentages: [], ...overrides };
}

function assertRejected(verdict: GuardVerdict, guard: GuardName): void {
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.guard, guard);
}

function assertOk(verdict: GuardVerdict): void {
  assert.deepEqual(verdict, { ok: true });
}

test("splitSentences splits a reply into its three sentences, keeping ., ! and ?", () => {
  const sentences = splitSentences("Isso é ótimo. Que legal! Você topa?");
  assert.equal(sentences.length, 3);
  assert.ok(sentences[0].includes("ótimo") && sentences[0].trim().endsWith("."));
  assert.ok(sentences[1].includes("legal") && sentences[1].trim().endsWith("!"));
  assert.ok(sentences[2].includes("topa") && sentences[2].trim().endsWith("?"));
});

test("rejects an English reply for language", () => {
  const reply = "What is the maximum price you would like to spend on this property?";
  assertRejected(checkReply(reply, context()), "language");
});

test("rejects three questions in one reply for questionCount", () => {
  const reply =
    "Qual é o valor que você tem em mente? Quantos quartos você precisa? Você tem um bairro preferido?";
  assertRejected(checkReply(reply, context()), "questionCount");
});

test("rejects a second question that refines neither the pending nor the next slot", () => {
  const reply = "Qual é a sua faixa de preço para este imóvel? Você tem um bairro preferido?";
  assertRejected(
    checkReply(reply, context({ pendingSlot: "priceMax", nextSlot: "bedrooms" })),
    "questionCount",
  );
});

test("rejects a BRL amount no search returned and the lead never stated", () => {
  const reply = "Encontrei uma opção por R$ 850.000 que pode te interessar.";
  assertRejected(checkReply(reply, context({ allowedAmounts: [] })), "unbackedFigure");
});

test("rejects a percentage no search returned and the lead never stated", () => {
  const reply = "A valorização média da região gira em torno de 7% ao ano.";
  assertRejected(checkReply(reply, context({ allowedPercentages: [] })), "unbackedFigure");
});

test("rejects a leaked toolCall JSON blob for leakedSyntax", () => {
  const reply = 'Só um instante. {"name": "updateSlots", "arguments": {"priceMax": 700000}}';
  assertRejected(checkReply(reply, context()), "leakedSyntax");
});

test("rejects a leaked <tool_call> tag for leakedSyntax", () => {
  const reply = "Deixa eu confirmar isso. <tool_call>updateSlots</tool_call> Perfeito, já anotei!";
  assertRejected(checkReply(reply, context()), "leakedSyntax");
});

test("rejects a reply that mentions the system prompt for leakedSyntax", () => {
  const reply = "Não posso revelar o meu system prompt, mas posso te ajudar com o que precisar.";
  assertRejected(checkReply(reply, context()), "leakedSyntax");
});

test("accepts a refining second question about the pending slot", () => {
  const reply = "Quantos quartos você busca? E tem preferência por suíte?";
  assertOk(checkReply(reply, context({ pendingSlot: "bedrooms", nextSlot: null })));
});

test("accepts a second question that previews the script's next slot", () => {
  const reply = "Qual é a sua faixa de preço para este imóvel? Você já sabe quantos quartos gostaria?";
  assertOk(checkReply(reply, context({ pendingSlot: "priceMax", nextSlot: "bedrooms" })));
});

test("accepts a normal one-question pt-BR reply", () => {
  const reply = "Qual é a sua faixa de preço para este imóvel?";
  assertOk(checkReply(reply, context()));
});

test("accepts a short pt-BR exclamation on its own, too short for the language check", () => {
  assertOk(checkReply("Perfeito!", context()));
});

test("accepts an amount written as R$ 850.000 when that figure is allowed", () => {
  const reply = "Esse imóvel está por R$ 850.000, dentro do que você pediu.";
  assertOk(checkReply(reply, context({ allowedAmounts: [850_000] })));
});

test("accepts the same amount written as 850 mil when that figure is allowed", () => {
  const reply = "Esse imóvel está por 850 mil, dentro do que você pediu.";
  assertOk(checkReply(reply, context({ allowedAmounts: [850_000] })));
});

test("createReplyGuard counts questions across sentences, not per sentence", () => {
  const guard = createReplyGuard(context({ pendingSlot: "priceMax", nextSlot: "bedrooms" }));
  assertOk(guard.check("Qual é a sua faixa de preço para este imóvel?"));
  assertOk(guard.check("Você já sabe quantos quartos gostaria?"));
  assertRejected(guard.check("E qual bairro você prefere?"), "questionCount");
});
