import test from "node:test";
import assert from "node:assert/strict";
import { writeFollowup } from "../../src/agent/followup-writer.ts";

/**
 * INTEGRATION=1, local e4b — spec 006 T030, SC-006: from a stored summary, the
 * follow-up names the neighbourhood and the price ceiling and ends with a
 * question. Recorded either way: whether the model's opening passed its checks
 * or the code-written one replaced it.
 */
const integration = process.env.INTEGRATION === "1";

test("SC-006: the follow-up reopens with context and ends with the pending question", { skip: !integration }, async () => {
  const message = await writeFollowup({
    intent: "purchase",
    slots: { priceMax: 700000, bedrooms: 2, neighborhoods: ["Moema"] },
    summary:
      "Camila procura um apartamento de 2 quartos em Moema, até R$ 700 mil. Ana Ribeiro conversou com ela. Falta saber a urgência.",
    leadName: "Camila",
    proposalOpen: false,
    teamNames: ["Ana Ribeiro", "Bruno Castro"],
  });
  console.log(`opening: ${message.opening} — ${message.text}`);
  assert.match(message.text, /Moema/);
  assert.match(message.text, /700/);
  assert.ok(message.text.trim().endsWith("?"), message.text);
  assert.doesNotMatch(message.text, /\bAna\b|\bBruno\b/);
});
