import test from "node:test";
import assert from "node:assert/strict";
import { boundaryOffer, offerOutcome, readAct, readRemainder, settleAct } from "../src/agent/decide/boundary.ts";
import { readAcknowledgement } from "../src/agent/lexicon.ts";

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
