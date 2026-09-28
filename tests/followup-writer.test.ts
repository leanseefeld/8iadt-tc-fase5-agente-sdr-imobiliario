import test from "node:test";
import assert from "node:assert/strict";
import {
  fallbackOpening,
  openingProblem,
  pendingQuestion,
  searchDetail,
} from "../src/agent/followup-writer.ts";
import { QUESTIONS } from "../src/domain/slots.ts";

/**
 * Spec 006 FR-014 — the follow-up's parts that are code: the question it ends
 * with, the checks on the model's opening, and the opening that replaces it.
 */

const SLOTS = { priceMax: 700000, bedrooms: 2, neighborhoods: ["Moema"] };

test("the message ends with the question the script left hanging", () => {
  assert.equal(pendingQuestion({ intent: "purchase", slots: SLOTS, proposalOpen: false }), QUESTIONS.urgency);
  assert.equal(pendingQuestion({ intent: "undefined", slots: {}, proposalOpen: false }), QUESTIONS.intent);
});

test("an open proposal is invited back without quoting a single time (FR-014)", () => {
  const question = pendingQuestion({ intent: "purchase", slots: SLOTS, proposalOpen: true });
  assert.match(question, /\?/);
  assert.doesNotMatch(question, /\d/);
});

test("the opening's detail is what the lead is looking for", () => {
  assert.equal(searchDetail(SLOTS), "de 2 quartos em Moema, até R$ 700 mil");
  assert.equal(searchDetail({ priceMax: 1_200_000 }), "até R$ 1,2 milhão");
  assert.equal(searchDetail({}), "");
  assert.equal(
    fallbackOpening({ slots: SLOTS, leadName: "Camila Andrade", intent: "purchase" }),
    "Oi, Camila! Passando para retomar a busca pelo imóvel de 2 quartos em Moema, até R$ 700 mil.",
  );
});

test("an opening with a question, a date or hour, or a team member's name is refused", () => {
  const team = ["Ana Ribeiro", "Bruno Castro"];
  assert.equal(openingProblem("Oi, Camila! Seguem as opções em Moema até 700 mil.", team), null);
  assert.equal(openingProblem("Ainda procura em Moema?", team), "question");
  assert.equal(openingProblem("A visita de quinta segue de pé em Moema.", team), "date_or_time");
  assert.equal(openingProblem("Tenho um horário às 10h em Moema.", team), "date_or_time");
  assert.equal(openingProblem("Tenho 14:30 livre.", team), "date_or_time");
  assert.equal(openingProblem("A Ana separou opções em Moema.", team), "team_name");
  assert.equal(openingProblem("", team), "empty");
  assert.equal(openingProblem("Oi, [Nome da pessoa]! Retomando sua busca em Moema.", team), "placeholder");
});
