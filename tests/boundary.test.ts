import test from "node:test";
import assert from "node:assert/strict";
import { boundaryOffer, offerOutcome, readAct, readRemainder, settleAct } from "../src/agent/decide/boundary.ts";
import { asksForMoreProperties, readAcknowledgement, readClosedAnswer, readOptionPick } from "../src/agent/lexicon.ts";

/** Spec 015 — what the agent can't resolve, decided in code. */

test("a message that is only thanks or agreement is read by code", () => {
  const cases: Array<[string, "thanks" | "agree" | null]> = [
    ["obrigado!", "thanks"],
    ["Muito obrigada 😊", "thanks"],
    ["valeu!!", "thanks"],
    ["agradecido! 😊", "thanks"],
    ["ok, obrigado", "thanks"],
    ["beleza", "agree"],
    ["show", "agree"],
    ["tá bom então", "agree"],
    ["👍", "agree"],
    ["ah, perfeito", "agree"],
    // More than an acknowledgement: the model's reading stands.
    ["obrigado, e meu marido vai junto", null],
    ["ok, mas aceita cachorro?", null],
    ["não, obrigado", null],
    ["quinta", null],
    ["", null],
  ];
  for (const [text, expected] of cases) assert.equal(readAcknowledgement(text), expected, text);
});

test("the act the turn goes by", () => {
  // The safety net: a bare thank-you is thanks, whatever the model said.
  assert.equal(settleAct("inform", "valeu!", "valeu"), "thanks");
  // More than thanks, with something left over: information.
  assert.equal(settleAct("thanks", "obrigado, e meu marido vai junto", "meu marido vai junto"), "inform");
  assert.equal(settleAct(null, "meu marido vai junto", "meu marido vai junto"), "inform");
  // Otherwise the model's act.
  assert.equal(settleAct("question", "o condomínio aceita cachorro?", "aceita cachorro?"), "question");
  assert.equal(settleAct("answer", "700 mil", null), "answer");
});

test("an offer only for a request, question or information nothing else answered", () => {
  const about = "meu marido vai junto";
  assert.deepEqual(boundaryOffer({ act: "inform", remainder: about, phrasedTurn: true }), { about });
  assert.deepEqual(boundaryOffer({ act: "question", remainder: about, phrasedTurn: true }), { about });
  assert.deepEqual(boundaryOffer({ act: "request", remainder: about, phrasedTurn: true }), { about });
  assert.equal(boundaryOffer({ act: "inform", remainder: about, phrasedTurn: false }), null, "something else answers");
  assert.equal(boundaryOffer({ act: "inform", remainder: null, phrasedTurn: true }), null, "nothing left over");
  assert.equal(boundaryOffer({ act: "thanks", remainder: about, phrasedTurn: true }), null);
  assert.equal(boundaryOffer({ act: "answer", remainder: about, phrasedTurn: true }), null);
});

test("what the lead did with the offer", () => {
  assert.equal(offerOutcome("yes"), "handoff");
  assert.equal(offerOutcome("no"), "close");
  assert.equal(offerOutcome(null), null, "moved on: the normal turn");
});

test("the extraction's act and remainder, as the 4-bit model writes them", () => {
  assert.equal(readAct(" Question "), "question");
  assert.equal(readAct("pergunta"), null);
  assert.equal(readAct(null), null);
  assert.equal(readRemainder("  meu  marido vai junto "), "meu marido vai junto");
  for (const empty of ["", "null", "nada", "-", null, 3]) assert.equal(readRemainder(empty), null, String(empty));
  assert.equal(readRemainder("x".repeat(300))?.length, 200);
});

test("asking for more properties is the criteria question, read by code", () => {
  for (const text of ["queria ver outros imóveis também", "tem mais opções?", "e outras casas?", "mais apartamentos"]) {
    assert.equal(asksForMoreProperties(text), true, text);
  }
  for (const text of ["meu marido vai junto", "outro dia", "mais tarde", "imóveis"]) {
    assert.equal(asksForMoreProperties(text), false, text);
  }
});

test("with times on the table, an ordinal is a pick, read by code", () => {
  const cases: Array<[string, number | null]> = [
    ["a primeira", 1],
    ["2", 2],
    ["pode ser a segunda opção", 2],
    ["opção 3", 3],
    ["a terceira, por favor", 3],
    ["quero a 1", 1],
    ["a primeira que você mandou de manhã", null],
    ["segunda às 10", null],
    ["obrigado", null],
  ];
  for (const [text, expected] of cases) assert.equal(readOptionPick(text), expected, text);
});

test("the answer to a closed question, read from the words it offered (08/10)", () => {
  const cases: Array<["intent" | "urgency", string, string | null]> = [
    ["intent", "alugar", "rental"],
    ["intent", "quero comprar", "purchase"],
    ["intent", "investir", "investment"],
    ["intent", "comprar ou alugar, não sei", null],
    ["urgency", "só olhando", "exploring"],
    ["urgency", "inicial", "exploring"],
    ["urgency", "em breve", "soon"],
    ["urgency", "preciso me mudar logo", "immediate"],
    ["urgency", "o quanto antes", "immediate"],
    ["urgency", "não sei", null],
  ];
  for (const [slot, text, expected] of cases) assert.equal(readClosedAnswer(slot, text), expected, `${slot}: ${text}`);
});
