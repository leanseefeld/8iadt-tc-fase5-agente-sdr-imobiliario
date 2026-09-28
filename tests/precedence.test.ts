import test from "node:test";
import assert from "node:assert/strict";
import { turnBriefing, type TurnPromptInput } from "../src/agent/prompts/system.ts";
import { noMatchReply } from "../src/agent/prompts/fallback.ts";
import { lastSearchOutcome, type LoadedTurn } from "../src/services/conversation.ts";
import { EMPTY_SLOTS } from "../src/domain/slots.ts";

/**
 * Spec 007's closing amendment (FR-032, FR-033, FR-035; SC-012, SC-013).
 * Two recorded conversations, b0561984… and 28c0e0e5…, showed a search result
 * losing to a reconfirmation, a question about results answered with a bare
 * restatement, and a no-match offering a widening nothing performs.
 */

const base: TurnPromptInput = {
  intent: "purchase",
  slots: { ...EMPTY_SLOTS, priceMax: 600_000, bedrooms: 2, neighborhoods: ["Vila Mariana"] },
  filled: ["priceMax"],
  question: null,
  consented: true,
  meeting: null,
  notUnderstood: false,
};
const RECONFIRM = "Só pra confirmar: até R$ 600 mil, 2 quartos, Vila Mariana. Continua assim?";

test("FR-032: a no-match outranks a reconfirmation", () => {
  const briefing = turnBriefing({
    ...base,
    reconfirmation: RECONFIRM,
    suggestions: { count: 0, relaxable: "neighborhoods" },
  });
  assert.match(briefing, /não encontrou nenhum imóvel/);
  assert.equal(briefing.includes(RECONFIRM), false);
});

test("FR-032: cards outrank a reconfirmation and a criteria question", () => {
  const briefing = turnBriefing({
    ...base,
    reconfirmation: RECONFIRM,
    askedAboutCriteria: true,
    suggestions: { count: 1, relaxable: null },
  });
  assert.match(briefing, /encontrou um imóvel/);
  assert.equal(briefing.includes(RECONFIRM), false);
  assert.doesNotMatch(briefing, /critérios que já estão no estado/);
});

test("FR-032: with no search this turn, the reconfirmation still speaks", () => {
  const briefing = turnBriefing({ ...base, reconfirmation: RECONFIRM });
  assert.ok(briefing.includes(RECONFIRM));
});

test("FR-033: a results question after an empty search is answered with the fact", () => {
  const briefing = turnBriefing({ ...base, askedAboutCriteria: true, lastSearch: { count: 0 } });
  assert.match(briefing, /não encontrou nenhum imóvel/);
  assert.match(briefing, /nenhum imóvel encontrado/);
});

test("FR-033: the fact is not repeated on a turn that searched", () => {
  const briefing = turnBriefing({
    ...base,
    lastSearch: { count: 0 },
    suggestions: { count: 2, relaxable: null },
  });
  assert.doesNotMatch(briefing, /Última busca/);
});

test("FR-035: no no-match offers to widen the search on the lead's behalf", () => {
  for (const relaxable of ["neighborhoods", "priceMax", "bedrooms", null] as const) {
    const written = noMatchReply(relaxable);
    const briefed = turnBriefing({ ...base, suggestions: { count: 0, relaxable } });
    for (const text of [written, briefed]) {
      assert.doesNotMatch(text, /posso procurar|procurar em bairros vizinhos|esticar/i, text);
    }
  }
});

function turnWith(
  intent: LoadedTurn["lead"]["intent"],
  history: { role: "agent" | "lead"; metadata: Record<string, unknown> }[],
): LoadedTurn {
  return { lead: { intent }, history } as unknown as LoadedTurn;
}

test("FR-033: lastSearchOutcome reads the most recent search", () => {
  const turn = turnWith("purchase", [
    { role: "agent", metadata: { toolCalls: [{ name: "searchProperties" }], propertyIds: ["a", "b", "c"] } },
    { role: "lead", metadata: {} },
    { role: "agent", metadata: { toolCalls: [{ name: "searchProperties" }], propertyIds: [] } },
    { role: "lead", metadata: {} },
    { role: "agent", metadata: { toolCalls: [{ name: "updateSlots" }] } },
  ]);
  assert.deepEqual(lastSearchOutcome(turn), { count: 0 });
});

test("FR-033: no search yet, or an intent that never searches, is null", () => {
  assert.equal(lastSearchOutcome(turnWith("purchase", [{ role: "agent", metadata: {} }])), null);
  const searched = turnWith("purchase", [
    { role: "agent", metadata: { toolCalls: [{ name: "searchProperties" }], propertyIds: ["a"] } },
  ]);
  assert.equal(lastSearchOutcome(searched, "investment"), null);
});

// ---------------------------------------------------------------------------
// Found by the 27/09 replay (conversations f911e8cd…, 37e9aa71…)
// ---------------------------------------------------------------------------

import { shouldRecover } from "../src/agent/orchestrator.ts";
import { reconfirmationSentence } from "../src/agent/prompts/reconfirm.ts";

test("US1 scenario 6: a message that attempted nothing is never mined for a slot", () => {
  const greeting = {
    stillPending: true,
    pendingIsIntent: false,
    saidSomething: false,
    leadText: "opa, tá aí?",
  };
  assert.equal(shouldRecover({ ...greeting, attemptedAnswer: false }), false);
  assert.equal(shouldRecover({ ...greeting, leadText: "Marlom", attemptedAnswer: true }), true);
});

test("US4: the reconfirmation names what changed before what it puts in doubt", () => {
  const slots = { ...EMPTY_SLOTS, priceMax: 1_200_000, bedrooms: 2 };
  assert.equal(
    reconfirmationSentence(slots, ["priceMax", "bedrooms"]),
    "Só pra confirmar: até R$ 1,2 mi, 2 quartos. Continua assim?",
  );
});
