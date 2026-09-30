import test from "node:test";
import assert from "node:assert/strict";
import { chooseMeeting, matchAnswer } from "../src/agent/meeting-change.ts";
import {
  MEETING_LIMIT_SENTENCE,
  closingSentence,
  cancelQuestion,
  cancelledSentence,
  keptSentence,
  rescheduleOptionsSentence,
  rescheduledSentence,
  whichOneSentence,
  type MeetingRef,
} from "../src/agent/prompts/meeting.ts";

/** Spec 009 — which meeting the lead means, and the sentences they read. */

const TZ = "America/Sao_Paulo";
const friday: MeetingRef = { id: "a", scheduledAt: new Date("2030-01-11T17:00:00Z"), type: "viewing", propertyCode: "VMA-0001" };
const tuesday: MeetingRef = { id: "b", scheduledAt: new Date("2030-01-08T13:00:00Z"), type: "viewing", propertyCode: "MOE-0008" };
const call: MeetingRef = { id: "c", scheduledAt: new Date("2030-01-09T19:30:00Z"), type: "call", propertyCode: null };
const none = { code: null, weekday: null, kind: null };

test("one meeting is the one; none is none", () => {
  assert.deepEqual(chooseMeeting([friday], none, "cancel", TZ), { meeting: friday });
  assert.deepEqual(chooseMeeting([], none, "cancel", TZ), { none: true });
});

test("several: narrowed by code, by kind, and — for a cancel — by weekday; otherwise ask", () => {
  assert.deepEqual(chooseMeeting([friday, tuesday], none, "cancel", TZ), { ask: [friday, tuesday] });
  assert.deepEqual(chooseMeeting([friday, tuesday], { ...none, code: "moe-0008" }, "cancel", TZ), { meeting: tuesday });
  assert.deepEqual(chooseMeeting([friday, tuesday, call], { ...none, kind: "call" }, "reschedule", TZ), { meeting: call });
  assert.deepEqual(chooseMeeting([friday, tuesday], { ...none, weekday: "fri" }, "cancel", TZ), { meeting: friday });
  // "passa pra sexta" names where it goes, not which one.
  assert.deepEqual(chooseMeeting([friday, tuesday], { ...none, weekday: "fri" }, "reschedule", TZ), { ask: [friday, tuesday] });
  // A hint that matches nothing doesn't empty the list.
  assert.deepEqual(chooseMeeting([friday, tuesday], { ...none, code: "XYZ-0000" }, "cancel", TZ), { ask: [friday, tuesday] });
});

test("the sentences are code-written, name the meeting and never a broker", () => {
  assert.equal(cancelQuestion(friday, TZ), "Quer mesmo cancelar a visita ao VMA-0001 de sex 11/01 às 14h?");
  assert.equal(cancelledSentence(call, TZ), "Pronto, cancelei a conversa por telefone de qua 09/01 às 16h30. Quer marcar outro dia?");
  assert.equal(keptSentence(friday, TZ), "Tudo certo, a visita ao VMA-0001 de sex 11/01 às 14h continua marcada.");
  assert.equal(
    rescheduledSentence(tuesday.scheduledAt, "viewing", "MOE-0008", TZ),
    "Pronto! Sua visita ao MOE-0008 foi remarcada para ter 08/01 às 10h, com alguém da nossa equipe.",
  );
  assert.equal(
    whichOneSentence([friday, tuesday], TZ),
    "Qual delas: a visita ao VMA-0001 (sex 11/01 às 14h) ou a visita ao MOE-0008 (ter 08/01 às 10h)?",
  );
  assert.match(rescheduleOptionsSentence(friday, [tuesday.scheduledAt], TZ), /^Para remarcar a visita ao VMA-0001, tenho estes horários: 1\) ter 08\/01 às 10h\./);
  assert.match(MEETING_LIMIT_SENTENCE, /três compromissos/);
});

test("the answer to 'qual delas?' is read against the meetings just listed", () => {
  const pool = [friday, tuesday, call];
  assert.equal(matchAnswer(pool, "a de terça", TZ), tuesday);
  assert.equal(matchAnswer(pool, "a do VMA-0001", TZ), friday);
  assert.equal(matchAnswer(pool, "a por telefone", TZ), call);
  assert.equal(matchAnswer(pool, "a do dia 11", TZ), friday);
  assert.equal(matchAnswer(pool, "08/01", TZ), tuesday);
  assert.equal(matchAnswer(pool, "tanto faz", TZ), null, "nothing singled out");
  assert.equal(matchAnswer([friday, tuesday], "a visita", TZ), null, "both are visits");
});

test("parseWhen reads the calendar words by code — weekdays, periods, hoje/amanhã", async () => {
  const { parseWhen } = await import("../src/agent/meeting-change.ts");
  const tuesday = new Date("2026-09-29T20:00:00Z"); // ter 29/09, 17h in São Paulo
  assert.deepEqual(parseWhen("nada na quarta?", tuesday, TZ), { weekday: "wed" });
  assert.deepEqual(parseWhen("essa pode ser amanhã de tarde mesmo", tuesday, TZ), { weekday: "wed", period: "afternoon" });
  assert.deepEqual(parseWhen("amanhã de manhã", tuesday, TZ), { weekday: "wed", period: "morning" });
  assert.deepEqual(parseWhen("depois de amanhã", tuesday, TZ), { weekday: "thu" });
  assert.deepEqual(parseWhen("tem como ser na sexta-feira de manhã?", tuesday, TZ), { weekday: "fri", period: "morning" });
  assert.deepEqual(parseWhen("hoje à tarde", tuesday, TZ), { weekday: "tue", period: "afternoon" });
  assert.deepEqual(parseWhen("terça ou quarta", tuesday, TZ), {}, "two days is not one");
  assert.deepEqual(parseWhen("obrigado!", tuesday, TZ), {});
  assert.deepEqual(parseWhen("pode ser a segunda opção", tuesday, TZ), {}, "option two, not Monday");
});

test("the closing restates what is booked and leaves the door open", () => {
  assert.equal(
    closingSentence([tuesday, call], "obrigado!", TZ),
    "Por nada! Fica marcado: a visita ao MOE-0008 (ter 08/01 às 10h) e a conversa por telefone (qua 09/01 às 16h30). Se precisar de algo, é só chamar.",
  );
  assert.equal(closingSentence([], "não, obrigado", TZ), "Combinado! Se precisar de algo, é só chamar.", "a no-thanks is not a thank-you");
  assert.equal(
    closingSentence([tuesday, call], "não, obrigado", TZ, true),
    "Combinado! Se precisar de algo, é só chamar.",
    "a second close in a row doesn't repeat the summary",
  );
});
