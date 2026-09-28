import test from "node:test";
import assert from "node:assert/strict";
import { accountTurn } from "../src/agent/orchestrator.ts";
import { EXTRACTION_FAILURE_REPLY } from "../src/agent/prompts/fallback.ts";
import { handoffDecision } from "../src/domain/handoff.ts";

/**
 * SC-004b. Ten failed extractions: ten technical replies, no handoff, and a
 * streak that never moves. The reply is the written sentence; the count is
 * `accountTurn`, which `run()` uses on this path.
 */

const FAILED = {
  learnedSomething: false,
  extractionFailed: true,
  attemptedAnswer: true,
  droppedCount: 0,
  steering: false,
} as const;

test("a failed extraction is a technical reply, not an apology for not understanding", () => {
  assert.equal(/não entendi/i.test(EXTRACTION_FAILURE_REPLY), false);
  assert.match(EXTRACTION_FAILURE_REPLY, /problema técnico/i);
  assert.match(EXTRACTION_FAILURE_REPLY, /repetir/i);
});

test("ten unreachable turns hold the streak and never hand off", () => {
  let streak = 0;
  for (let turn = 0; turn < 10; turn++) {
    const accounted = accountTurn(streak, FAILED);
    assert.equal(accounted.notUnderstood, false, `turn ${turn}`);
    streak = accounted.fallbackStreak;
  }
  assert.equal(streak, 0);
  assert.equal(handoffDecision({ leadAskedForHuman: false, fallbackStreak: streak }), null);
});
