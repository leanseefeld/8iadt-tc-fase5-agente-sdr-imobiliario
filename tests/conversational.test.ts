import test from "node:test";
import assert from "node:assert/strict";
import { accountTurn } from "../src/agent/orchestrator.ts";
import { handoffDecision } from "../src/domain/handoff.ts";
import { EMPTY_SLOTS, mergeSlots, type Intent, type QualificationState, type Slots } from "../src/domain/slots.ts";

/**
 * SC-004a. The decision is the streak rule, not a model call: a message that
 * attempts nothing holds the count, and two of them do not hand off. The mixed
 * case is social and substantive, so the slot still merges.
 */

function state(intent: Intent, slots: Partial<Slots> = {}): QualificationState {
  return { intent, slots: { ...EMPTY_SLOTS, ...slots } };
}

const SOCIAL = ["Nossa, isso seria bom haha", "opa, tá aí?", "valeu!", "👍"] as const;

for (const text of SOCIAL) {
  test(`${JSON.stringify(text)} does not advance the streak and is not a misunderstanding`, () => {
    const held = accountTurn(1, {
      learnedSomething: false,
      extractionFailed: false,
      attemptedAnswer: false,
      droppedCount: 0,
      steering: false,
    });
    assert.equal(held.notUnderstood, false, text);
    assert.equal(held.fallbackStreak, 1, text);
  });
}

test("two conversational turns in a row raise no handoff", () => {
  let streak = 0;
  for (const _text of SOCIAL.slice(0, 2)) {
    streak = accountTurn(streak, {
      learnedSomething: false,
      extractionFailed: false,
      attemptedAnswer: false,
      droppedCount: 0,
      steering: false,
    }).fallbackStreak;
  }
  assert.equal(streak, 0);
  assert.equal(handoffDecision({ leadAskedForHuman: false, fallbackStreak: streak }), null);
});

test("an interjection between two misunderstandings holds the count", () => {
  const first = accountTurn(0, {
    learnedSomething: false,
    extractionFailed: false,
    attemptedAnswer: true,
    droppedCount: 0,
    steering: false,
  });
  assert.equal(first.fallbackStreak, 1);
  assert.equal(first.notUnderstood, true);

  const held = accountTurn(first.fallbackStreak, {
    learnedSomething: false,
    extractionFailed: false,
    attemptedAnswer: false,
    droppedCount: 0,
    steering: false,
  });
  assert.equal(held.fallbackStreak, 1);
  assert.equal(held.notUnderstood, false);

  const third = accountTurn(held.fallbackStreak, {
    learnedSomething: false,
    extractionFailed: false,
    attemptedAnswer: true,
    droppedCount: 0,
    steering: false,
  });
  assert.equal(third.fallbackStreak, 2);
  assert.equal(handoffDecision({ leadAskedForHuman: false, fallbackStreak: third.fallbackStreak }), "fallback");
});

test('"opa! pode ser até 900 mil" merges the budget and the turn is ordinary', () => {
  const merged = mergeSlots(state("purchase", { priceMax: 700_000 }), { priceMax: 900_000 }, { consented: true });
  assert.equal(merged.slots.priceMax, 900_000);
  assert.deepEqual(merged.revised, ["priceMax"]);
  assert.deepEqual(merged.filled, []);

  const turn = accountTurn(1, {
    learnedSomething: merged.revised.length > 0,
    extractionFailed: false,
    attemptedAnswer: true,
    droppedCount: 0,
    steering: false,
  });
  assert.equal(turn.notUnderstood, false);
  assert.equal(turn.fallbackStreak, 0);
});
