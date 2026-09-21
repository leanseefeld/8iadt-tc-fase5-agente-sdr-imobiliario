import test from "node:test";
import assert from "node:assert/strict";
import { PREVIEW_LINE_MAX_CHARS, truncatePreviewLine } from "../src/agent/summarizer.ts";

/**
 * FR-012's half that is enforced rather than prompted. No model, no database:
 * the limit a table cell cannot absorb is the one that has to hold every time.
 */

test("a short line is returned as it came, minus the model's quotes", () => {
  assert.equal(truncatePreviewLine("Contrato de aluguel vence em 6 semanas"), "Contrato de aluguel vence em 6 semanas");
  assert.equal(truncatePreviewLine('"Quer visitar na quinta"'), "Quer visitar na quinta");
  assert.equal(truncatePreviewLine("“Procura 2 quartos em Moema”"), "Procura 2 quartos em Moema");
});

test("surrounding whitespace and inner runs collapse", () => {
  assert.equal(truncatePreviewLine("  Quer   visitar\n  na quinta  "), "Quer visitar na quinta");
});

test("an over-long line is cut at a word boundary, never mid-word", () => {
  const long =
    "Procura apartamento de dois quartos na zona sul de São Paulo com orçamento " +
    "de até setecentos mil reais e precisa se mudar rapidamente";
  const cut = truncatePreviewLine(long);

  assert.ok(cut.length <= PREVIEW_LINE_MAX_CHARS + 1, `got ${cut.length} chars`);
  assert.ok(cut.endsWith("…"));
  const body = cut.slice(0, -1);
  assert.ok(long.startsWith(body), "the kept part is a prefix of the original");
  assert.ok(!body.endsWith(" "), "no trailing space before the ellipsis");
  assert.ok(long[body.length] === " ", "the cut lands on a word boundary");
});

test("exactly the limit is not truncated", () => {
  const exact = "a".repeat(PREVIEW_LINE_MAX_CHARS);
  assert.equal(truncatePreviewLine(exact), exact);
});

test("one word longer than the limit is still cut, because a cell cannot grow", () => {
  const word = "b".repeat(PREVIEW_LINE_MAX_CHARS + 20);
  const cut = truncatePreviewLine(word);
  assert.ok(cut.length <= PREVIEW_LINE_MAX_CHARS + 1);
  assert.ok(cut.endsWith("…"));
});

test("punctuation left dangling by the cut is dropped", () => {
  const line = `${"palavra ".repeat(10)}fim, ${"resto ".repeat(5)}`;
  const cut = truncatePreviewLine(line);
  assert.ok(!cut.includes(",…"), "no comma immediately before the ellipsis");
});
