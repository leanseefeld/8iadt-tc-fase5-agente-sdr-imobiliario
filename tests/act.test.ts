import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ACTION_STEPS } from "../src/agent/act.ts";
import { actionTools, runSearchProperties } from "../src/agent/tools/index.ts";
import { EMPTY_SLOTS } from "../src/domain/slots.ts";

test("the action loop is bounded at three steps", () => {
  assert.equal(MAX_ACTION_STEPS, 3);
});

const search = { agencyId: "00000000-0000-0000-0000-000000000000", intent: "purchase" as const, slots: EMPTY_SLOTS };
const booking = { conversationId: "00000000-0000-0000-0000-000000000001", offered: [], timezone: "America/Sao_Paulo" };

test("a turn gets only the tools it has a reason for", () => {
  assert.deepEqual(Object.keys(actionTools({ search })), ["searchProperties"]);
  assert.deepEqual(Object.keys(actionTools({ booking })), ["bookMeeting"]);
  assert.deepEqual(Object.keys(actionTools({ search, booking })), ["searchProperties", "bookMeeting"]);
  assert.deepEqual(Object.keys(actionTools({})), []);
  const reschedule = { appointmentId: "00000000-0000-0000-0000-000000000002", offered: [], timezone: "America/Sao_Paulo" };
  assert.deepEqual(Object.keys(actionTools({ reschedule })), ["rescheduleMeeting"], "spec 009");
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
