import test from "node:test";
import assert from "node:assert/strict";
import { turnBriefing, type TurnPromptInput } from "../src/agent/prompts/system.ts";
import { EMPTY_SLOTS } from "../src/domain/slots.ts";

/**
 * FR-019, SC-004. One boundary assertion: the briefing payload cannot carry
 * lead assessment, because those fields are not on the type the prompt reads.
 */

const PERMITTED = [
  "intent",
  "slots",
  "filled",
  "question",
  "consented",
  "meeting",
  "notUnderstood",
  "broker",
  "suggestions",
  "reconfirmation",
  "askedAboutCriteria",
  "lastSearch",
] as const;

test("TurnPromptInput carries only the permitted fields", () => {
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
  for (const key of Object.keys(input)) {
    assert.ok(
      (PERMITTED as readonly string[]).includes(key),
      `${key} is not a permitted briefing field`,
    );
  }
  const briefing = turnBriefing(input);
  assert.equal(/score|temperatura|fallback|pipeline/i.test(briefing), false);
  assert.match(briefing, /critérios que já estão no estado/);
});
