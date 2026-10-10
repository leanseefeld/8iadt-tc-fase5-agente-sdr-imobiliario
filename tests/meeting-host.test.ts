import test from "node:test";
import assert from "node:assert/strict";
import {
  confirmationSentence,
  meetingHost,
  optionsSentence,
  rescheduledSentence,
} from "../src/agent/prompts/meeting.ts";

/** Scenario 2 of the challenge: an investor is directed to a specialist, and is told so. */

const TZ = "America/Sao_Paulo";
const at = new Date("2030-01-11T17:00:00Z");

test("an investor whose broker specializes in investment hears 'especialista'; anyone else hears the team", () => {
  assert.equal(meetingHost(true), "nosso especialista em investimentos");
  assert.equal(meetingHost(false), "alguém da nossa equipe");
});

test("the call sentences carry the host, and default to the team", () => {
  const specialist = meetingHost(true);
  assert.equal(
    optionsSentence([at], "call", null, TZ, specialist),
    "Tenho estes horários para uma conversa por telefone com nosso especialista em investimentos: 1) sex 11/01 às 14h. Esse horário fica bom?",
  );
  assert.equal(
    confirmationSentence(at, "call", null, TZ, specialist),
    "Pronto! Sua conversa por telefone está confirmada para sex 11/01 às 14h, com nosso especialista em investimentos.",
  );
  assert.equal(
    rescheduledSentence(at, "call", null, TZ, specialist),
    "Pronto! Sua conversa por telefone foi remarcada para sex 11/01 às 14h, com nosso especialista em investimentos.",
  );
  assert.match(confirmationSentence(at, "call", null, TZ), /com alguém da nossa equipe\.$/);
});
