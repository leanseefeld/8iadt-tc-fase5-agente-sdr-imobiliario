import test from "node:test";
import assert from "node:assert/strict";
import { closePool, getDb } from "../../src/db/client.ts";
import { reminderSentence } from "../../src/agent/prompts/meeting.ts";
import { localParts, zonedInstant } from "../../src/domain/scheduling.ts";
import { recordOutboundMessage } from "../../src/services/conversation.ts";
import { syncReminder } from "../../src/services/reminder.ts";
import { bookDirect, qualifiedLead, query, type Lead } from "../integration/support/meeting.ts";

/**
 * INTEGRATION=1, local model — spec 017 example 7: the lead answers the meeting
 * reminder, and the real turn handles it like any other message. The meeting is
 * tomorrow at 10h, its reminder is queued as booking would queue it, and the
 * reminder itself is the sentence the worker sends ("…amanhã às 10h…").
 */
const integration = process.env.INTEGRATION === "1";
const TZ = "America/Sao_Paulo";
const DAY = 24 * 60 * 60_000;

/** Tomorrow at 10h in São Paulo. */
function tomorrowAtTen(): Date {
  const local = localParts(new Date(Date.now() + DAY), TZ);
  return zonedInstant(local.year, local.month, local.day, 10 * 60, TZ);
}

async function status(id: string): Promise<{ status: string; scheduled_at: Date }> {
  const [row] = await query("select status, scheduled_at from appointments where id = $1", [id]);
  return row as never;
}

async function pendingReminders(appointmentId: string): Promise<Array<{ scheduled_for: Date }>> {
  return (await query(
    "select scheduled_for from followup_jobs where appointment_id = $1 and kind = 'reminder' and status = 'pending'",
    [appointmentId],
  )) as never;
}

test("answering the meeting reminder", { skip: !integration }, async (t) => {
  const leads: Lead[] = [];
  const facts = async (created: Lead) => JSON.stringify((await created.lastMetadata()).toolCalls);

  /** A booked lead who has just received the reminder. */
  async function reminded(): Promise<{ lead: Lead; id: string; at: Date }> {
    const lead = await qualifiedLead({ brokerName: "Ana Ribeiro" });
    leads.push(lead);
    const at = tomorrowAtTen();
    const id = await bookDirect(lead, { at, propertyCode: "VMA-0001" });
    await syncReminder(getDb(), id);
    const text = reminderSentence(
      { scheduledAt: at, type: "viewing", propertyCode: "VMA-0001", investmentSpecialist: false, leadName: "Camila", held: false },
      new Date(),
      TZ,
    );
    await recordOutboundMessage({ conversationId: lead.conversationId, content: text, reminderFor: id, now: new Date(Date.now() - 1000) });
    return { lead, id, at };
  }

  /** The lead's line and Sofia's answer, printed with the results for a person to read. */
  const said = async (sub: { diagnostic(message: string): void }, lead: Lead, text: string) => {
    const result = await lead.say(text);
    sub.diagnostic(`Lead: ${text} → Sofia: ${result.reply}`);
    return result;
  };

  t.after(async () => {
    for (const created of leads) await created.cleanup();
    await closePool();
  });

  await t.test("1 · a thank-you: a short courtesy, no question, the schedule not repeated", async (st) => {
    const { lead, id } = await reminded();
    const reply = await said(st, lead, "obrigada! estarei lá");
    assert.doesNotMatch(reply.reply, /\?/, `asks nothing: ${reply.reply}`);
    assert.doesNotMatch(reply.reply, /\d{1,2}h|VMA-0001/, `the reminder already said it: ${reply.reply}`);
    assert.equal((await status(id)).status, "confirmed");
    assert.equal((await pendingReminders(id)).length, 1, "a lead's message never cancels the reminder");
  });

  await t.test("2 · an acknowledgement: the same", async (st) => {
    const { lead, id } = await reminded();
    const reply = await said(st, lead, "ok, combinado");
    assert.doesNotMatch(reply.reply, /\?/, `asks nothing: ${reply.reply}`);
    assert.doesNotMatch(reply.reply, /\d{1,2}h|VMA-0001/, `the reminder already said it: ${reply.reply}`);
    assert.equal((await status(id)).status, "confirmed");
  });

  await t.test("3 · cancel: asks first, cancels on yes, and the reminder goes with the meeting", async (st) => {
    const { lead, id } = await reminded();
    const ask = await said(st, lead, "não vou conseguir ir amanhã, pode cancelar?");
    assert.match(ask.reply, /^Quer mesmo cancelar a visita ao VMA-0001 de /, await facts(lead));
    assert.equal((await status(id)).status, "confirmed", "nothing before the yes");
    const done = await said(st, lead, "sim");
    assert.match(done.reply, /^Pronto, cancelei a visita ao VMA-0001 /, await facts(lead));
    assert.equal((await status(id)).status, "cancelled");
    assert.equal((await pendingReminders(id)).length, 0);
  });

  await t.test("4 · reschedule: the same meeting moves, and its reminder with it", async (st) => {
    const { lead, id, at } = await reminded();
    const moved = await said(st, lead, "não consigo amanhã, dá pra passar pra terça às 14h?");
    assert.match(moved.reply, /^Pronto! Sua visita ao VMA-0001 foi remarcada para ter .* às 14h/, await facts(lead));
    const row = await status(id);
    assert.notEqual(new Date(row.scheduled_at).getTime(), at.getTime());
    const [reminder] = await pendingReminders(id);
    assert.equal(new Date(reminder.scheduled_for).getTime(), new Date(row.scheduled_at).getTime() - 2 * 60 * 60_000);
  });

  await t.test("5 · another booking on top: phone options, both stand, each with its reminder", async (st) => {
    const { lead, id } = await reminded();
    const offer = await said(st, lead, "obrigada! aproveitando, dá pra marcar também uma conversa por telefone?");
    assert.match(offer.reply, /Tenho estes horários para uma conversa por telefone/, await facts(lead));
    const booked = await said(st, lead, "pode ser a primeira opção");
    assert.match(booked.reply, /^Pronto! Sua conversa por telefone está confirmada/, await facts(lead));
    assert.equal((await status(id)).status, "confirmed", "the visit stands");
    const confirmed = await query(
      "select id from appointments where lead_id = $1 and status = 'confirmed' order by scheduled_at",
      [lead.leadId],
    );
    assert.equal(confirmed.length, 2);
    for (const row of confirmed) assert.equal((await pendingReminders(row.id as string)).length, 1, "one reminder per meeting");
  });

  await t.test("6 · opting out: no more messages, and the meeting stands", async (st) => {
    const { lead, id } = await reminded();
    await said(st, lead, "para de me mandar mensagem, por favor");
    const [row] = await query("select do_not_contact from leads where id = $1", [lead.leadId]);
    assert.equal(row.do_not_contact, true);
    assert.equal((await status(id)).status, "confirmed", "opting out does not cancel the visit");
  });
});
