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

// ---------------------------------------------------------------------------
// Spec 006 FR-005g — one reply per turn, and the decline as a prefix (SC-017)
// ---------------------------------------------------------------------------

import { accountTurn, meetingTarget, readSchedulingFacts, replyKind, type ReplyKind } from "../src/agent/orchestrator.ts";
import {
  confirmationSentence,
  optionsSentence,
  slotLabel,
} from "../src/agent/prompts/meeting.ts";

test("FR-005g: every pair of reply kinds that can meet — the higher-ranked one decides", () => {
  const ranked: ReplyKind[] = ["confirmation", "options", "search", "criteria", "reconfirmation", "question"];
  const flag: Record<ReplyKind, keyof Parameters<typeof replyKind>[0] | null> = {
    confirmation: "booked",
    options: "options",
    search: "searched",
    criteria: "askedAboutCriteria",
    reconfirmation: "reconfirmation",
    question: null,
  };
  const none = { booked: false, options: false, searched: false, askedAboutCriteria: false, reconfirmation: false };
  for (let high = 0; high < ranked.length; high += 1) {
    for (let low = high + 1; low < ranked.length; low += 1) {
      const turn = { ...none };
      for (const kind of [ranked[high], ranked[low]]) {
        const key = flag[kind];
        if (key !== null) turn[key] = true;
      }
      assert.equal(replyKind(turn), ranked[high], `${ranked[high]} over ${ranked[low]}`);
    }
  }
  assert.equal(replyKind(none), "question");
});

test("FR-005g: after a decline, the briefing forbids offering again and the reconfirmation is not in it", () => {
  const briefing = turnBriefing({ ...base, declinedOffer: true, suggestions: { count: 2, relaxable: null } });
  assert.match(briefing, /Não ofereça horários, visita nem conversa de novo/);
  assert.match(briefing, /separou 2/, "the search result still wins the phrased part");
  assert.equal(briefing.includes(RECONFIRM), false);
});

test("FR-005d/FR-005e: the scheduling sentences are code-written and name no one", () => {
  const tz = "America/Sao_Paulo";
  const times = [new Date("2030-01-07T13:00:00Z"), new Date("2030-01-07T19:30:00Z")];
  const options = optionsSentence(times, "viewing", "VMA-0005", tz);
  assert.equal(
    options,
    "Tenho estes horários para uma visita ao VMA-0005 com alguém da nossa equipe: 1) seg 07/01 às 10h · 2) seg 07/01 às 16h30. Qual fica melhor?",
  );
  assert.equal(
    confirmationSentence(times[0], "call", null, tz),
    "Pronto! Sua conversa por telefone está confirmada para seg 07/01 às 10h, com alguém da nossa equipe.",
  );
  assert.equal(slotLabel(new Date("2030-01-11T13:00:00Z"), tz), "sex 11/01 às 10h");
});

test("spec 006: the extraction's meeting facts are read strictly, and anything malformed is absent", () => {
  assert.deepEqual(
    readSchedulingFacts({ pickedTime: "sim", preferredWeekday: "thu", preferredPeriod: "morning", propertyCode: " VMA-0005 " }),
    { declinedOffer: false, askedForTimes: false, pickedTime: true, preference: { weekday: "thu", period: "morning" }, propertyRef: { code: "VMA-0005" }, askedWhoAttends: false, meetingKind: null, unsupportedMeeting: false, outOfScopeRequest: false },
  );
  assert.deepEqual(readSchedulingFacts({ propertyPosition: 2 }).propertyRef, { position: 2 });
  assert.deepEqual(readSchedulingFacts({ propertyPosition: 0, preferredWeekday: "quinta", preferredPeriod: "noite" }), {
    declinedOffer: false, askedForTimes: false, pickedTime: false, preference: {}, propertyRef: null, askedWhoAttends: false,
    meetingKind: null, unsupportedMeeting: false, outOfScopeRequest: false,
  });
});

test("FR-004e/f: a visit needs a property; the only other meeting is by phone", () => {
  const vma = { id: "p1", code: "VMA-0001" };
  const base = { intent: "purchase" as const, kind: null, property: null, reofferingCall: false, cardsShown: false };
  assert.equal(meetingTarget({ ...base, property: vma }), "viewing");
  assert.equal(meetingTarget({ ...base, cardsShown: true }), "ask_property", "cards on screen, none pointed at");
  assert.equal(meetingTarget({ ...base, kind: "visit", cardsShown: true }), "ask_property");
  assert.equal(meetingTarget(base), "call", "nothing ever shown: the phone is what there is");
  assert.equal(meetingTarget({ ...base, kind: "call", property: vma }), "call", "asked for the phone, gets the phone");
  assert.equal(meetingTarget({ ...base, reofferingCall: true, cardsShown: true }), "call", "other times for a phone offer");
  assert.equal(meetingTarget({ ...base, kind: "visit", reofferingCall: true, cardsShown: true }), "ask_property");
  assert.equal(meetingTarget({ ...base, intent: "investment", kind: "visit", property: vma }), "call", "FR-003a");
});

test("FR-005h/i: a request the agency can't meet advances the streak, even when something was learned", () => {
  const turn = { learnedSomething: false, extractionFailed: false, attemptedAnswer: true, droppedCount: 0 };
  assert.deepEqual(accountTurn(0, { ...turn, refused: true }), { notUnderstood: true, fallbackStreak: 1 });
  assert.deepEqual(accountTurn(1, { ...turn, refused: true, learnedSomething: true }), { notUnderstood: true, fallbackStreak: 2 });
  assert.deepEqual(accountTurn(1, { ...turn, acted: true }), { notUnderstood: false, fallbackStreak: 0 });
});

test("the new meeting facts are read strictly", () => {
  const facts = readSchedulingFacts({ meetingKind: "call", unsupportedMeeting: "sim", outOfScopeRequest: true });
  assert.equal(facts.meetingKind, "call");
  assert.equal(facts.unsupportedMeeting, true);
  assert.equal(facts.outOfScopeRequest, true);
  assert.equal(readSchedulingFacts({ meetingKind: "zoom" }).meetingKind, null);
});
