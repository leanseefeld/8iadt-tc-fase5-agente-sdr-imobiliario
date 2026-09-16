import test from "node:test";
import assert from "node:assert/strict";
import {
  SCRIPT,
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

test("SCRIPT lists purchase and rental slots in price, bedrooms, neighborhoods, urgency, name, contact order", () => {
  assert.deepEqual(SCRIPT.purchase, ["priceMax", "bedrooms", "neighborhoods", "urgency", "name", "contact"]);
  assert.deepEqual(SCRIPT.rental, SCRIPT.purchase);
});

test("SCRIPT lists investment slots in investorProfile, ticket, returnExpectation, name, contact order", () => {
  assert.deepEqual(SCRIPT.investment, ["investorProfile", "ticket", "returnExpectation", "name", "contact"]);
});

test("SCRIPT.undefined has an empty script, and nextQuestion for it only asks about the intent", () => {
  assert.deepEqual(SCRIPT.undefined, []);
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
  // it was already filled before this merge, so this is not an empty -> filled transition
  assert.deepEqual(result.filled, []);
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
});

test("mergeSlots rule 3: intent never moves between two already-identified values", () => {
  const current = state("purchase");
  const result = mergeSlots(current, { intent: "rental" }, { consented: true });
  assert.equal(result.intent, "purchase");
  assert.ok(result.dropped.includes("intent"));
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
