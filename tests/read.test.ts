import test from "node:test";
import assert from "node:assert/strict";
import { NO_SCHEDULING, readTurn, type ModelReading, type ReadingContext } from "../src/agent/turn/read.ts";

/**
 * The turn's first node: the model's reading, settled by what code reads from
 * a closed vocabulary. Everything after it decides from this output.
 */

const TZ = "America/Sao_Paulo";
// A Tuesday, 29/09/2026, 21h in São Paulo.
const NOW = new Date("2026-09-30T00:00:00Z");

const nothing: ModelReading = {
  attemptedAnswer: false,
  leadAskedForHuman: false,
  optedOut: false,
  askedAboutCriteria: false,
  scheduling: NO_SCHEDULING,
  act: null,
  remainder: null,
};

function read(text: string, model: Partial<ModelReading> = {}, context: Partial<ReadingContext> = {}) {
  return readTurn(
    { ...nothing, ...model },
    { text, now: NOW, timeZone: TZ, optionsOnTable: false, yesNoPending: false, ...context },
  );
}

test("a bare thanks requests nothing, whatever the model echoed", () => {
  const reading = read("valeu!", {
    leadAskedForHuman: true,
    optedOut: true,
    scheduling: { ...NO_SCHEDULING, outOfScopeRequest: true, unsupportedMeeting: true },
    act: "inform",
  });
  assert.equal(reading.leadAskedForHuman, false);
  assert.equal(reading.optedOut, false);
  assert.equal(reading.facts.outOfScopeRequest, false);
  assert.equal(reading.facts.unsupportedMeeting, false);
  assert.equal(reading.act, "thanks");
  // A real request is left alone.
  assert.equal(read("quero falar com um corretor", { leadAskedForHuman: true }).leadAskedForHuman, true);
});

test("asking for more properties is the criteria question, never a remainder", () => {
  const reading = read("queria ver outros imóveis também", { remainder: "outros imóveis", act: "request" });
  assert.equal(reading.askedAboutCriteria, true);
  assert.equal(reading.remainder, null);
});

test("the day and period named in the text win over the model's guess", () => {
  const reading = read("pode ser amanhã de tarde", {
    scheduling: { ...NO_SCHEDULING, preference: { weekday: "tue" } },
  });
  assert.deepEqual(reading.facts.preference, { weekday: "wed", period: "afternoon" });
  assert.equal(reading.namesADay, true);
});

test("an ordinal is a pick only with options on the table", () => {
  assert.equal(read("a primeira", {}, { optionsOnTable: true }).facts.pickedTime, true);
  assert.equal(read("a primeira").facts.pickedTime, false);
});

test("yes and no are read from the words only when a yes/no question is pending", () => {
  assert.equal(read("não, deixa", {}, { yesNoPending: true }).answer, "no");
  assert.equal(read("sim, pode", {}, { yesNoPending: true }).answer, "yes");
  assert.equal(read("não, deixa").answer, null);
  const model = { scheduling: { ...NO_SCHEDULING, answer: "yes" as const } };
  assert.equal(read("hmm", model, { yesNoPending: true }).answer, "yes", "the extraction's answer stands");
});

test("the change verbs", () => {
  assert.deepEqual(
    ["dá pra passar pra segunda?", "não vou mais poder", "obrigado"].map((text) => {
      const reading = read(text);
      return [reading.changeVerb, reading.cancelVerb];
    }),
    [
      [true, false],
      [false, true],
      [false, false],
    ],
  );
});

test("'não vou mais poder' is a cancel unless the message says to move it", () => {
  const reschedule = { scheduling: { ...NO_SCHEDULING, changeRequest: "reschedule" as const } };
  assert.equal(read("não vou mais poder na sexta", reschedule).facts.changeRequest, "cancel");
  assert.equal(read("não vou poder na sexta, dá pra passar pra segunda?", reschedule).facts.changeRequest, "reschedule");
  assert.equal(read("queria remarcar", reschedule).facts.changeRequest, "reschedule");
});

test("a fact the model claims must be in the words (the echoes of 07/10)", () => {
  const echoedCode = { scheduling: { ...NO_SCHEDULING, propertyRef: { code: "MOE-0009" } } };
  assert.equal(read("vou levar meu cachorro", echoedCode).facts.propertyRef, null, "the card's code, echoed");
  assert.deepEqual(read("Interessado em MOE-0009", echoedCode).facts.propertyRef, { code: "MOE-0009" });
  assert.deepEqual(read("e o moe 0009?", echoedCode).facts.propertyRef, { code: "MOE-0009" });

  const refusal = { scheduling: { ...NO_SCHEDULING, outOfScopeRequest: true } };
  assert.equal(read("posso levar meu cachorro?", refusal).facts.outOfScopeRequest, false);
  assert.equal(read("vocês me dão carona até lá?", refusal).facts.outOfScopeRequest, true);
  assert.equal(read("quero ser atendida por uma mulher", refusal).facts.outOfScopeRequest, true);

  for (const text of ["já marcamos, não?", "a visita continua de pé?", "ficou agendado pra terça?"]) {
    assert.equal(read(text).facts.askedAboutMeetings, true, text);
  }
  for (const text of ["podemos marcar uma nova?", "quero marcar uma visita", "obrigado"]) {
    assert.equal(read(text).facts.askedAboutMeetings, false, text);
  }
});

test("an acknowledgement attempts nothing, so it is never a misunderstanding", () => {
  assert.equal(read("beleza", { attemptedAnswer: true }).attemptedAnswer, false);
  assert.equal(read("ok", { attemptedAnswer: true }).attemptedAnswer, false);
  assert.equal(read("700 mil", { attemptedAnswer: true }).attemptedAnswer, true);
});

test("a short reply is an answer attempt, never something for the team (Azure, 08/10)", () => {
  for (const text of ["inicial", "pelo menos 2", "2", "não sei"]) {
    assert.equal(read(text, { remainder: text, act: "other" }).remainder, null, text);
  }
  for (const text of ["meu marido vai junto", "vou levar cachorro", "aceita pet?"]) {
    assert.notEqual(read(text, { remainder: text, act: "inform" }).remainder, null, text);
  }
});
