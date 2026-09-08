import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_SLOTS, type Slots } from "../src/domain/slots.ts";
import { scoreLead } from "../src/domain/score.ts";
import { handoffDecision, shouldProposeMeeting } from "../src/domain/handoff.ts";

/** No DB, no model — the two triggers of ADR 19 and the one that is not a trigger. */

const purchaseComplete: Slots = {
  ...EMPTY_SLOTS,
  priceMax: 700_000,
  bedrooms: 2,
  neighborhoods: ["Moema"],
  urgency: "immediate",
  name: "Camila",
  contact: "11999998888",
};

const investmentComplete: Slots = {
  ...EMPTY_SLOTS,
  investorProfile: "firstTime",
  ticket: 350_000,
  returnExpectation: "income",
  name: "Bruno",
  contact: "bruno@example.com",
};

test("no handoff while the lead has asked for nobody and nothing has failed", () => {
  assert.equal(handoffDecision({ leadAskedForHuman: false, fallbackStreak: 0 }), null);
});

test("the lead asking for a person hands off with reason asked", () => {
  assert.equal(handoffDecision({ leadAskedForHuman: true, fallbackStreak: 0 }), "asked");
});

test("one fallback is not yet a handoff; two consecutive ones are", () => {
  assert.equal(handoffDecision({ leadAskedForHuman: false, fallbackStreak: 1 }), null);
  assert.equal(handoffDecision({ leadAskedForHuman: false, fallbackStreak: 2 }), "fallback");
});

test("asked outranks fallback when both conditions hold", () => {
  assert.equal(handoffDecision({ leadAskedForHuman: true, fallbackStreak: 3 }), "asked");
});

// ADR 19: this is the case that used to be a third handoff trigger and is not one.
test("a hot purchase lead with a known contact is offered a viewing, never a handoff", () => {
  const score = scoreLead("purchase", purchaseComplete);
  assert.equal(score, 100);
  assert.equal(shouldProposeMeeting("purchase", purchaseComplete, score), "viewing");
  assert.equal(handoffDecision({ leadAskedForHuman: false, fallbackStreak: 0 }), null);
});

test("a purchase lead with the script unfinished is offered nothing yet", () => {
  const slots: Slots = { ...purchaseComplete, urgency: null };
  assert.equal(shouldProposeMeeting("purchase", slots, scoreLead("purchase", slots)), null);
});

test("a purchase lead whose score is not hot is offered nothing", () => {
  const slots: Slots = { ...purchaseComplete, urgency: "exploring" };
  assert.equal(scoreLead("purchase", slots), 85);
  assert.equal(shouldProposeMeeting("purchase", slots, 60), null);
});

// A finished investment script is 10 + 45 + 15 = 70 at minimum, so it is always
// hot: FR-041's point is the KIND — a call with a specialist, never a viewing and
// never a property search — not a second score threshold.
test("the end of the investment script proposes a call with a specialist", () => {
  const score = scoreLead("investment", investmentComplete);
  assert.equal(score, 70);
  assert.equal(shouldProposeMeeting("investment", investmentComplete, score), "call");
  assert.equal(shouldProposeMeeting("investment", investmentComplete, 0), "call");
});

test("an undefined intent proposes nothing", () => {
  assert.equal(shouldProposeMeeting("undefined", purchaseComplete, 100), null);
});
