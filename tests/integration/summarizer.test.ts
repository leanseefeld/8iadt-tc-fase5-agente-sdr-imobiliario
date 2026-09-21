import test from "node:test";
import assert from "node:assert/strict";
import { summarizeConversation, PREVIEW_LINE_MAX_CHARS } from "../../src/agent/summarizer.ts";

/**
 * INTEGRATION=1 — the summary against the local model
 * (`gemma-4-e4b-it-OptiQ-4bit`), which is the only way to know the prompt works
 * on the model this project demonstrates with. SC-005's readable-Portuguese half
 * is a human judgement; what is asserted here is everything a machine can hold:
 * it produced something, in Portuguese, within the length a table cell allows.
 */
const integration = process.env.INTEGRATION === "1";

const CONVERSATION = [
  { role: "lead" as const, content: "Oi, procuro um apartamento para alugar na Vila Mariana" },
  { role: "agent" as const, content: "Claro! Qual valor de aluguel você tem em mente?" },
  { role: "lead" as const, content: "Até 3500 por mês, e preciso de 2 quartos" },
  { role: "agent" as const, content: "Perfeito. Para quando você precisa se mudar?" },
  { role: "lead" as const, content: "Meu contrato vence em 6 semanas, então é meio urgente" },
];

test("the summariser writes a broker-readable summary and a list line", {
  skip: !integration,
}, async () => {
  const result = await summarizeConversation({
    previousSummary: null,
    leadName: null,
    messages: CONVERSATION,
  });

  assert.ok(result.summary.length > 40, `too short to be a summary: ${result.summary}`);
  assert.ok(
    result.previewLine.length <= PREVIEW_LINE_MAX_CHARS,
    `preview line is ${result.previewLine.length} chars: ${result.previewLine}`,
  );
  assert.ok(result.previewLine.length > 0);

  // Portuguese, and about this conversation rather than about itself.
  const text = `${result.summary} ${result.previewLine}`.toLowerCase();
  assert.ok(
    /\b(alug|apartamento|quartos|mudar|contrato)/.test(text),
    `does not read like this conversation: ${text}`,
  );
  assert.ok(!/\bsummary\b|\bhere is\b/.test(text), `answered in English: ${text}`);
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(text), "no emoji in a broker surface");
});

test("a second pass carries the previous summary forward", {
  skip: !integration,
}, async () => {
  const first = await summarizeConversation({
    previousSummary: null,
    leadName: null,
    messages: CONVERSATION,
  });

  const second = await summarizeConversation({
    previousSummary: first.summary,
    leadName: null,
    messages: [
      { role: "lead", content: "Na verdade posso ir até 4000 se tiver vaga de garagem" },
    ],
  });

  assert.ok(second.summary.length > 40);
  assert.ok(second.previewLine.length <= PREVIEW_LINE_MAX_CHARS);
  // The new fact is the point of running it again.
  assert.ok(/4|quatro|garagem/i.test(second.summary), `lost the update: ${second.summary}`);
});
