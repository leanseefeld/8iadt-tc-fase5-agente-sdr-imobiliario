import test from "node:test";
import assert from "node:assert/strict";
import {
  allowedTransitions,
  assertTransition,
  canTransition,
  IllegalLeadTransition,
  isLeadStage,
  LEAD_STAGES,
} from "../src/domain/lead-status.ts";

/** FR-007 / ADR 19 §7. No database, no model — the table is the whole subject. */

test("the funnel moves forward one stage at a time", () => {
  assert.equal(canTransition("new", "qualifying"), true);
  assert.equal(canTransition("qualifying", "qualified"), true);
  assert.equal(canTransition("qualified", "scheduled"), true);
  assert.equal(canTransition("scheduled", "visited"), true);
});

test("the funnel also skips forward, because a broker may know more than the agent", () => {
  assert.equal(canTransition("new", "scheduled"), true);
  assert.equal(canTransition("qualifying", "visited"), true);
});

test("the funnel never walks backwards", () => {
  assert.equal(canTransition("qualified", "qualifying"), false);
  assert.equal(canTransition("visited", "scheduled"), false);
  assert.equal(canTransition("scheduled", "new"), false);
});

test("won and lost are reachable from any stage of the funnel", () => {
  for (const stage of ["new", "qualifying", "qualified", "scheduled", "visited"] as const) {
    assert.equal(canTransition(stage, "won"), true, `${stage} -> won`);
    assert.equal(canTransition(stage, "lost"), true, `${stage} -> lost`);
  }
});

test("an outcome is final: nothing leaves won or lost, not even the other outcome", () => {
  for (const stage of LEAD_STAGES) {
    assert.equal(canTransition("won", stage), false, `won -> ${stage}`);
    assert.equal(canTransition("lost", stage), false, `lost -> ${stage}`);
  }
});

test("staying put is not a transition", () => {
  for (const stage of LEAD_STAGES) {
    assert.equal(canTransition(stage, stage), false, `${stage} -> ${stage}`);
  }
});

test("allowedTransitions is what the panel may offer", () => {
  assert.deepEqual(allowedTransitions("new"), [
    "qualifying",
    "qualified",
    "scheduled",
    "visited",
    "won",
    "lost",
  ]);
  assert.deepEqual(allowedTransitions("visited"), ["won", "lost"]);
  assert.deepEqual(allowedTransitions("won"), []);
});

test("assertTransition throws with both stages on the error", () => {
  assert.doesNotThrow(() => assertTransition("qualified", "scheduled"));
  assert.throws(
    () => assertTransition("visited", "qualifying"),
    (error: unknown) => {
      assert.ok(error instanceof IllegalLeadTransition);
      assert.equal(error.from, "visited");
      assert.equal(error.to, "qualifying");
      return true;
    },
  );
});

test("isLeadStage guards against a value arriving from a request body", () => {
  assert.equal(isLeadStage("qualified"), true);
  assert.equal(isLeadStage("handoff"), false);
  assert.equal(isLeadStage("unresponsive"), false);
});
