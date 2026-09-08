import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_SLOTS, type Slots } from "../src/domain/slots.ts";
import { scoreLead, temperature } from "../src/domain/score.ts";

/** No DB, no model — pure function over the weight table in modelo-de-dados.md §3. */

test("empty slots with an undefined intent score 0", () => {
  assert.equal(scoreLead("undefined", EMPTY_SLOTS), 0);
});

test("an identified intent alone scores 10", () => {
  assert.equal(scoreLead("purchase", EMPTY_SLOTS), 10);
});

test("each purchase qualifying slot filled adds 15 points", () => {
  const oneFilled: Slots = { ...EMPTY_SLOTS, priceMax: 700_000 };
  assert.equal(scoreLead("purchase", oneFilled), 25); // 10 + 15

  const twoFilled: Slots = { ...oneFilled, bedrooms: 2 };
  assert.equal(scoreLead("purchase", twoFilled), 40); // 10 + 30
});

test("contact filled adds 15 points on top of the qualifying slots", () => {
  const slots: Slots = { ...EMPTY_SLOTS, contact: "ana@example.com" };
  // contact is not one of purchase's qualifying slots, so this is 10 + 15 only
  assert.equal(scoreLead("purchase", slots), 25);
});

test("urgency immediate adds a 15 point bonus on top of its own qualifying weight", () => {
  const slots: Slots = { ...EMPTY_SLOTS, urgency: "immediate" };
  assert.equal(scoreLead("purchase", slots), 40); // 10 + 15 (filled) + 15 (bonus)
});

test("urgency soon adds a 5 point bonus, not the immediate bonus", () => {
  const slots: Slots = { ...EMPTY_SLOTS, urgency: "soon" };
  assert.equal(scoreLead("purchase", slots), 30); // 10 + 15 (filled) + 5 (bonus)
});

test("investment bonus: returnExpectation filled and not undecided with ticket >= 1,000,000 adds 15", () => {
  const slots: Slots = { ...EMPTY_SLOTS, ticket: 1_500_000, returnExpectation: "income" };
  assert.equal(scoreLead("investment", slots), 55); // 10 + 30 (2 qualifying slots) + 15 (bonus)
});

test("the investment bonus does not apply below the 1,000,000 ticket threshold", () => {
  const slots: Slots = { ...EMPTY_SLOTS, ticket: 500_000, returnExpectation: "income" };
  assert.equal(scoreLead("investment", slots), 40); // 10 + 30, no bonus
});

test("the investment bonus does not apply when returnExpectation is undecided", () => {
  const slots: Slots = { ...EMPTY_SLOTS, ticket: 2_000_000, returnExpectation: "undecided" };
  assert.equal(scoreLead("investment", slots), 40); // 10 + 30, undecided disqualifies the bonus
});

// Slots is one flat type shared by every intent, so a purchase lead can still carry
// values in investment-only fields. Stacking urgency=soon (+5) with the return/ticket
// bonus (+15) on top of a fully filled purchase script would total 105 uncapped.
test("score caps at 100 even when both bonus conditions are satisfied at once", () => {
  const slots: Slots = {
    ...EMPTY_SLOTS,
    priceMax: 700_000,
    bedrooms: 2,
    neighborhoods: [],
    urgency: "soon",
    contact: "ana@example.com",
    ticket: 2_000_000,
    returnExpectation: "income",
  };
  assert.equal(scoreLead("purchase", slots), 100);
});

test("a fully filled purchase lead scores exactly 100", () => {
  const slots: Slots = {
    ...EMPTY_SLOTS,
    priceMax: 700_000,
    bedrooms: 2,
    neighborhoods: [],
    urgency: "immediate",
    name: "Ana",
    contact: "ana@example.com",
  };
  assert.equal(scoreLead("purchase", slots), 100); // 10 + 60 + 15 + 15
});

test("a fully filled investment lead scores exactly 85", () => {
  const slots: Slots = {
    ...EMPTY_SLOTS,
    investorProfile: "experienced",
    ticket: 2_000_000,
    returnExpectation: "appreciation",
    name: "Ana",
    contact: "ana@example.com",
  };
  assert.equal(scoreLead("investment", slots), 85); // 10 + 45 + 15 + 15
});

test("temperature crosses from cold to warm at the 39/40 boundary", () => {
  assert.equal(temperature(39), "cold");
  assert.equal(temperature(40), "warm");
});

test("temperature crosses from warm to hot at the 69/70 boundary", () => {
  assert.equal(temperature(69), "warm");
  assert.equal(temperature(70), "hot");
});
