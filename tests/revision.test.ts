import test from "node:test";
import assert from "node:assert/strict";
import { accountTurn } from "../src/agent/orchestrator.ts";
import { reconfirmationSentence } from "../src/agent/prompts/reconfirm.ts";
import {
  DEPENDANTS,
  orphanedSlots,
  reconfirmationFor,
  reconfirmationKeys,
} from "../src/domain/revision.ts";
import {
  EMPTY_SLOTS,
  SLOT_KEYS,
  mergeSlots,
  type Askable,
  type Intent,
  type QualificationState,
  type SlotKey,
  type Slots,
} from "../src/domain/slots.ts";

function state(intent: Intent, slots: Partial<Slots> = {}): QualificationState {
  return { intent, slots: { ...EMPTY_SLOTS, ...slots } };
}

const FULL: Slots = {
  priceMax: 1_200_000,
  bedrooms: 3,
  neighborhoods: ["Moema"],
  urgency: "soon",
  investorProfile: "firstTime",
  ticket: 1_200_000,
  returnExpectation: "income",
  name: "Ana",
  contact: "ana@example.com",
};

test("the dependant table lists no name, no contact, no self, and at most three real keys", () => {
  for (const [slot, dependants] of Object.entries(DEPENDANTS) as [Askable, readonly SlotKey[]][]) {
    assert.equal(dependants.includes("name" as SlotKey), false, slot);
    assert.equal(dependants.includes("contact" as SlotKey), false, slot);
    assert.equal(dependants.includes(slot as SlotKey), false, slot);
    assert.ok(dependants.length <= 3, slot);
    for (const dependant of dependants) {
      assert.ok(SLOT_KEYS.includes(dependant), dependant);
    }
  }
});

test("a price revision restates bedrooms and neighborhoods, and omits what is empty", () => {
  const keys = reconfirmationFor({ revised: ["priceMax"], intentChanged: false }, {
    ...FULL,
    bedrooms: null,
  });
  assert.deepEqual(keys, ["neighborhoods"]);
});

test("two revisions in one turn produce one union, in script order", () => {
  const keys = reconfirmationFor(
    { revised: ["neighborhoods", "priceMax"], intentChanged: false },
    FULL,
  );
  assert.deepEqual(keys, ["priceMax", "bedrooms", "neighborhoods"]);
});

test("an intent change restates the carried criteria, and orphans stay stored but are not current", () => {
  const keys = reconfirmationFor({ revised: [], intentChanged: true }, FULL);
  assert.deepEqual(keys, ["priceMax", "urgency"]);
  const orphans = orphanedSlots("investment", FULL);
  assert.ok(orphans.includes("priceMax"));
  assert.ok(orphans.includes("bedrooms"));
  assert.equal(orphans.includes("ticket"), false);
});

test("a reconfirmation sentence asks exactly one question", () => {
  for (const slot of Object.keys(DEPENDANTS) as Askable[]) {
    if (slot === "intent" || slot === "name" || slot === "contact") continue;
    const keys = reconfirmationFor({ revised: [slot], intentChanged: false }, FULL);
    const sentence = reconfirmationSentence(FULL, keys);
    if (keys.length === 0) {
      assert.equal(sentence, null, slot);
      continue;
    }
    assert.ok(sentence !== null);
    assert.equal((sentence.match(/\?/g) ?? []).length, 1, sentence);
    assert.match(sentence, /^Só pra confirmar: /);
  }
});

test("a reconfirmation never follows a reconfirmation", () => {
  const again = reconfirmationKeys({ revised: ["priceMax"], intentChanged: false }, FULL, true);
  assert.deepEqual(again, []);
  const first = reconfirmationKeys({ revised: ["priceMax"], intentChanged: false }, FULL, false);
  assert.deepEqual(first, ["bedrooms", "neighborhoods"]);
});

test("answering a reconfirmation with a correction merges it", () => {
  const merged = mergeSlots(state("purchase", { priceMax: 1_200_000, bedrooms: 3 }), { bedrooms: 2 }, {
    consented: true,
  });
  assert.equal(merged.slots.bedrooms, 2);
  assert.deepEqual(merged.revised, ["bedrooms"]);
  const turn = accountTurn(0, {
    learnedSomething: true,
    extractionFailed: false,
    attemptedAnswer: true,
    droppedCount: 0,
    steering: false,
  });
  assert.equal(turn.fallbackStreak, 0);
  assert.equal(turn.notUnderstood, false);
});

test("confirming a reconfirmation changes nothing and is not a misunderstanding", () => {
  const merged = mergeSlots(state("purchase", FULL), { priceMax: 1_200_000 }, { consented: true });
  assert.deepEqual(merged.revised, []);
  assert.deepEqual(merged.filled, []);
  const turn = accountTurn(0, {
    learnedSomething: false,
    extractionFailed: false,
    attemptedAnswer: true,
    droppedCount: 0,
    steering: false,
    confirming: true,
  });
  assert.equal(turn.notUnderstood, false);
  assert.equal(turn.fallbackStreak, 0);
});
