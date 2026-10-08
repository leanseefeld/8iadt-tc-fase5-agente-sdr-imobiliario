import test from "node:test";
import assert from "node:assert/strict";
import { chooseTask, turnBriefing, type TurnPromptInput } from "../src/agent/prompts/system.ts";
import { EMPTY_SLOTS } from "../src/domain/slots.ts";

/**
 * FR-019, SC-004. One boundary assertion: the briefing payload cannot carry
 * lead assessment, because those fields are not on the type the prompt reads.
 */

// The type the prompt reads is the boundary (TypeScript holds it); what is
// checked here is what reaches the words: no assessment of the lead.
test("the briefing carries no assessment of the lead", () => {
  const input: TurnPromptInput = {
    intent: "purchase",
    slots: { ...EMPTY_SLOTS, priceMax: 700_000, bedrooms: 2, neighborhoods: ["Moema"] },
    filled: ["priceMax"],
    question: null,
    consented: true,
    meeting: null,
    notUnderstood: false,
    askedAboutCriteria: true,
  };
  const briefing = turnBriefing(input);
  assert.equal(/score|temperatura|fallback|pipeline/i.test(briefing), false);
  assert.equal(chooseTask(input).id, "criteria.recite");
});

// FR-005e is a privacy rule, so its presence in the words is what is tested.
test("spec 006 FR-005e: after a handback, attendance is neither confirmed nor denied", () => {
  const briefing = turnBriefing({
    intent: "purchase",
    slots: EMPTY_SLOTS,
    filled: [],
    question: null,
    consented: true,
    meeting: null,
    notUnderstood: false,
    broker: { name: "Ana", justReturned: false },
  });
  assert.match(briefing, /não confirme nem negue que será Ana/);
});

test("spec 006 FR-005e: the reply rules forbid naming who will attend", async () => {
  const { REPLY_SYSTEM_PROMPT } = await import("../src/agent/prompts/system.ts");
  assert.match(REPLY_SYSTEM_PROMPT, /quem vai atendê-la/);
  assert.match(REPLY_SYSTEM_PROMPT, /Nunca diga que uma\s+pessoa específica da equipe vai atender/);
});
