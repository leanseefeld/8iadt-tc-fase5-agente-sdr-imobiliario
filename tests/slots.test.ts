import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_SLOTS,
  nextQuestion,
  upcomingSlots,
  mergeSlots,
  isQualified,
  qualifyingSlots,
  QUESTIONS,
  type Slots,
  type Intent,
  type QualificationState,
  hasEvidence,
} from "../src/domain/slots.ts";

/** No DB, no model — pure functions over the script and the merge rules. */

function state(intent: Intent, slots: Partial<Slots> = {}): QualificationState {
  return { intent, slots: { ...EMPTY_SLOTS, ...slots } };
}

test("with no intent yet, the only question is the intent", () => {
  assert.deepEqual(nextQuestion(state("undefined"), false), { slot: "intent", question: QUESTIONS.intent });
  assert.deepEqual(upcomingSlots(state("undefined"), false), ["intent"]);
});

test("nextQuestion and upcomingSlots pick the first empty slot in script order", () => {
  const st = state("purchase", { priceMax: 700_000 });
  assert.deepEqual(upcomingSlots(st, true), ["bedrooms", "neighborhoods", "urgency", "name", "contact"]);
  assert.deepEqual(nextQuestion(st, true), { slot: "bedrooms", question: QUESTIONS.bedrooms });
});

// bedrooms is filled but sits in the middle of the script; priceMax (before it)
// and neighborhoods/urgency (after it) must still be asked, and bedrooms never re-asked.
test("a filled slot in the middle of the script is skipped, not re-asked", () => {
  const st = state("purchase", { bedrooms: 3 });
  assert.deepEqual(upcomingSlots(st, true), ["priceMax", "neighborhoods", "urgency", "name", "contact"]);
  assert.deepEqual(nextQuestion(st, true), { slot: "priceMax", question: QUESTIONS.priceMax });
});

test("nextQuestion returns null once the script is finished", () => {
  const st = state("purchase", {
    priceMax: 700_000,
    bedrooms: 2,
    neighborhoods: [],
    urgency: "soon",
    name: "Ana",
    contact: "ana@example.com",
  });
  assert.equal(nextQuestion(st, true), null);
  assert.deepEqual(upcomingSlots(st, true), []);
});

test("name and contact are not askable before consent, even as the only slots left", () => {
  const st = state("purchase", { priceMax: 700_000, bedrooms: 2, neighborhoods: [], urgency: "soon" });
  assert.equal(nextQuestion(st, false), null);
  assert.deepEqual(upcomingSlots(st, false), []);
});

test("neighborhoods set to an empty array counts as filled, and the next question moves past it", () => {
  const st = state("purchase", { priceMax: 700_000, bedrooms: 2, neighborhoods: [] });
  assert.deepEqual(nextQuestion(st, true), { slot: "urgency", question: QUESTIONS.urgency });
});

test("neighborhoods left null does not count as filled, and stays the next question", () => {
  const st = state("purchase", { priceMax: 700_000, bedrooms: 2 });
  assert.deepEqual(nextQuestion(st, true), { slot: "neighborhoods", question: QUESTIONS.neighborhoods });
});

test("mergeSlots rule 1: a filled slot is never overwritten by null", () => {
  const current = state("purchase", { priceMax: 700_000 });
  const result = mergeSlots(current, { priceMax: null }, { consented: true });
  assert.equal(result.slots.priceMax, 700_000);
  assert.deepEqual(result.dropped, ["priceMax"]);
  assert.deepEqual(result.filled, []);
});

test("mergeSlots rule 1: a filled slot IS replaced by a different non-empty value", () => {
  const current = state("purchase", { priceMax: 700_000 });
  const result = mergeSlots(current, { priceMax: 900_000 }, { consented: true });
  assert.equal(result.slots.priceMax, 900_000);
  assert.deepEqual(result.dropped, []);
  // it was already filled before this merge, so this is a revision, not a first fill
  assert.deepEqual(result.filled, []);
  assert.deepEqual(result.revised, ["priceMax"]);
  assert.equal(result.intentChanged, false);
});

test("mergeSlots rule 2: neighborhoods set to an empty array is a filled slot", () => {
  const current = state("purchase");
  const result = mergeSlots(current, { neighborhoods: [] }, { consented: true });
  assert.deepEqual(result.slots.neighborhoods, []);
  assert.deepEqual(result.filled, ["neighborhoods"]);
});

test("mergeSlots rule 3: intent moves from undefined to the extracted value", () => {
  const current = state("undefined");
  const result = mergeSlots(current, { intent: "purchase" }, { consented: true });
  assert.equal(result.intent, "purchase");
  // a first identification is not a change between two defined values
  assert.equal(result.intentChanged, false);
  assert.equal(result.dropped.includes("intent"), false);
});

test("mergeSlots: intent moves between two defined values and reports intentChanged", () => {
  const current = state("purchase");
  const result = mergeSlots(current, { intent: "rental" }, { consented: true });
  assert.equal(result.intent, "rental");
  assert.equal(result.intentChanged, true);
  assert.equal(result.dropped.includes("intent"), false);
});

test("mergeSlots rule 4: a value failing the schema is dropped, the rest of the extraction still applies", () => {
  const current = state("purchase");
  const result = mergeSlots(current, { priceMax: "muito caro", bedrooms: 3 }, { consented: true });
  assert.equal(result.slots.priceMax, null);
  assert.ok(result.dropped.includes("priceMax"));
  assert.equal(result.slots.bedrooms, 3);
  assert.ok(result.filled.includes("bedrooms"));
});

test("mergeSlots rule 5: name and contact are dropped entirely while consented is false", () => {
  const current = state("purchase");
  const result = mergeSlots(current, { name: "Ana", contact: "ana@example.com" }, { consented: false });
  assert.equal(result.slots.name, null);
  assert.equal(result.slots.contact, null);
  assert.deepEqual(result.dropped.slice().sort(), ["contact", "name"]);
});

test("mergeSlots drops unknown keys", () => {
  const current = state("purchase");
  const result = mergeSlots(current, { favoriteColor: "blue" }, { consented: true });
  assert.deepEqual(result.slots, current.slots);
  assert.ok(result.dropped.includes("favoriteColor"));
});

test("MergeResult.filled lists exactly the slots that went empty to filled, in script order", () => {
  const current = state("purchase");
  // extraction order is reversed on purpose: filled must still come back in script order
  const result = mergeSlots(current, { bedrooms: 2, priceMax: 700_000 }, { consented: true });
  assert.deepEqual(result.filled, ["priceMax", "bedrooms"]);
});

test("qualifyingSlots excludes name and contact from the script", () => {
  assert.deepEqual(qualifyingSlots("purchase"), ["priceMax", "bedrooms", "neighborhoods", "urgency"]);
  assert.deepEqual(qualifyingSlots("investment"), ["investorProfile", "ticket", "returnExpectation"]);
});

test("isQualified is true only when every qualifying slot for the intent is filled", () => {
  const st = state("purchase", { priceMax: 700_000, bedrooms: 2, neighborhoods: [], urgency: "soon" });
  assert.equal(isQualified(st.intent, st.slots), true);
});

test("isQualified is false while one qualifying slot is still empty", () => {
  const st = state("purchase", { priceMax: 700_000, bedrooms: 2, neighborhoods: [] });
  assert.equal(isQualified(st.intent, st.slots), false);
});

test("isQualified is false while the intent is undefined, regardless of slot state", () => {
  assert.equal(isQualified("undefined", EMPTY_SLOTS), false);
});

// --- the evidence gate (FR-010, structurally) --------------------------------

test("hasEvidence accepts a prazo the lead actually raised", () => {
  assert.equal(hasEvidence("urgency", "Preciso me mudar em até 2 meses"), true);
  assert.equal(hasEvidence("urgency", "ainda estou pesquisando"), true);
  assert.equal(hasEvidence("urgency", "tenho pressa"), true);
});

test("the evidence gate still drops a closed-set value the lead's words never raised (FR-025)", () => {
  assert.equal(hasEvidence("urgency", "quero comprar um apartamento de 2 quartos na zona sul"), false);
  assert.equal(hasEvidence("investorProfile", "até 700 mil em Moema"), false);
  assert.equal(hasEvidence("returnExpectation", "preciso de 2 quartos"), false);
});

test("hasEvidence rejects a prazo nobody mentioned", () => {
  // The message that made this necessary: three slots and not one word of prazo.
  assert.equal(
    hasEvidence("urgency", "Quero comprar apartamento de 2 quartos na zona sul até 700 mil"),
    false,
  );
});

test("hasEvidence reads the investor slots the same way", () => {
  assert.equal(hasEvidence("investorProfile", "é minha primeira aplicação"), true);
  assert.equal(hasEvidence("investorProfile", "quero algo em Moema"), false);
  assert.equal(hasEvidence("returnExpectation", "quero renda de aluguel"), true);
  assert.equal(hasEvidence("returnExpectation", "quero 3 quartos"), false);
});

test("hasEvidence does NOT recognise the question's own vocabulary", () => {
  // Deliberate, and the reason the orchestrator waives the gate for the slot the
  // script just asked about. Someone answering "inicial" to "...ou ainda é uma
  // pesquisa inicial?" is echoing the question — the strongest evidence there
  // is — and this word list cannot see it. Relying on the list alone told a lead
  // we had not understood them and counted a fallback toward a handoff.
  assert.equal(QUESTIONS.urgency.includes("inicial"), true);
  assert.equal(hasEvidence("urgency", "inicial"), false);
});

// --- revisable merge invariants (FR-001, FR-004) -----------------------------

function setsOf(result: ReturnType<typeof mergeSlots>): { filled: string[]; revised: string[]; dropped: string[] } {
  return { filled: result.filled, revised: result.revised, dropped: result.dropped };
}

test("a slot key appears in at most one of filled, revised and dropped", () => {
  const current = state("purchase", { priceMax: 700_000, bedrooms: 2 });
  const result = mergeSlots(
    current,
    { priceMax: 900_000, bedrooms: null, neighborhoods: ["Moema"], contact: "11999999999" },
    { consented: false },
  );
  const seen = new Set<string>();
  for (const key of [...result.filled, ...result.revised, ...result.dropped]) {
    assert.equal(seen.has(key), false, `${key} appears in more than one set: ${JSON.stringify(setsOf(result))}`);
    seen.add(key);
  }
  assert.deepEqual(result.revised, ["priceMax"]);
  assert.deepEqual(result.filled, ["neighborhoods"]);
  assert.ok(result.dropped.includes("bedrooms"));
  assert.ok(result.dropped.includes("contact"));
});

test("re-supplying an identical value puts the slot in none of filled, revised or dropped", () => {
  const current = state("purchase", { priceMax: 700_000, neighborhoods: ["Moema", "Vila Mariana"] });
  const result = mergeSlots(
    current,
    { priceMax: 700_000, neighborhoods: ["Moema", "Vila Mariana"], intent: "purchase" },
    { consented: true },
  );
  assert.deepEqual(result.filled, []);
  assert.deepEqual(result.revised, []);
  assert.deepEqual(result.dropped, []);
  assert.equal(result.intentChanged, false);
  assert.equal(result.slots.priceMax, 700_000);
});

test("an empty value over a filled slot is still dropped", () => {
  const current = state("purchase", { bedrooms: 3, neighborhoods: ["Moema"] });
  const result = mergeSlots(current, { bedrooms: null, neighborhoods: [] }, { consented: true });
  assert.equal(result.slots.bedrooms, 3);
  assert.ok(result.dropped.includes("bedrooms"));
  assert.equal(result.revised.includes("bedrooms"), false);
  // [] is a different filled value ("aberto a sugestões"), not an emptying
  assert.deepEqual(result.slots.neighborhoods, []);
  assert.deepEqual(result.revised, ["neighborhoods"]);
});

test("an unconsented contact slot is still dropped", () => {
  const current = state("purchase", { name: "Ana" });
  const result = mergeSlots(current, { name: "Camila", contact: "camila@example.com" }, { consented: false });
  assert.equal(result.slots.name, "Ana");
  assert.equal(result.slots.contact, null);
  assert.ok(result.dropped.includes("name"));
  assert.ok(result.dropped.includes("contact"));
  assert.deepEqual(result.revised, []);
  assert.deepEqual(result.filled, []);
});
