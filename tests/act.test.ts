import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ACTION_STEPS } from "../src/agent/act.ts";
import { actionTools, runSearchProperties } from "../src/agent/tools/index.ts";
import { EMPTY_SLOTS } from "../src/domain/slots.ts";

test("the action loop is bounded at three steps", () => {
  assert.equal(MAX_ACTION_STEPS, 3);
});

test("the action tool set is exactly searchProperties", () => {
  const tools = actionTools({
    agencyId: "00000000-0000-0000-0000-000000000000",
    intent: "purchase",
    slots: EMPTY_SLOTS,
  });
  assert.deepEqual(Object.keys(tools), ["searchProperties"]);
});

test("an investment search is not run", async () => {
  const outcome = await runSearchProperties({
    agencyId: "00000000-0000-0000-0000-000000000000",
    intent: "investment",
    slots: EMPTY_SLOTS,
  });
  assert.equal(outcome.searched, false);
  assert.deepEqual(outcome.properties, []);
});
