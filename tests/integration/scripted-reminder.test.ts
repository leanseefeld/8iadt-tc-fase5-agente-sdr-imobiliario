import test from "node:test";
import assert from "node:assert/strict";
import { closePool } from "../../src/db/client.ts";
import { recordOutboundMessage } from "../../src/services/conversation.ts";
import { useScriptedModel } from "../support/scripted-model.ts";
import { bookDirect, nextLocal, qualifiedLead, query, type Lead } from "./support/meeting.ts";

/**
 * Spec 017 example 7: the lead answers the meeting reminder, and Sofia handles
 * it as any other turn. The model is scripted (the extraction reads what each
 * case says it read), so what is tested is the code's answer to each reading.
 */
const integration = process.env.INTEGRATION === "1";

const REMINDER = "Oi, Camila! Passando pra lembrar: sua visita ao VMA-0001 é hoje às 14h, com alguém da nossa equipe. Pode avisar por aqui mesmo se não puder mais ou precisar remarcar.";

async function remind(lead: Lead, appointmentId: string): Promise<void> {
  await recordOutboundMessage({
    conversationId: lead.conversationId,
    content: REMINDER,
    reminderFor: appointmentId,
    now: new Date(Date.now() - 1000),
  });
}

async function status(id: string): Promise<string> {
  const [row] = await query("select status from appointments where id = $1", [id]);
  return row.status as string;
}

test("answers to the meeting reminder, scripted", { skip: !integration }, async (t) => {
  const model = useScriptedModel();
  const leads: Lead[] = [];
  const reminded = async () => {
    const lead = await qualifiedLead({ brokerName: "Ana Ribeiro" });
    leads.push(lead);
    const id = await bookDirect(lead, { at: nextLocal("fri", 14), propertyCode: "VMA-0001" });
    await remind(lead, id);
    return { lead, id };
  };
  t.after(async () => {
    model.restore();
    for (const lead of leads) await lead.cleanup();
    await closePool();
  });

  await t.test("the reminder is stored as the agent's, marked as a reminder", async () => {
    const { lead, id } = await reminded();
    assert.deepEqual((await lead.lastMetadata()).reminder, { appointmentId: id });
  });

  await t.test("a thank-you is courtesy only — the reminder already said what is booked", async () => {
    const { lead } = await reminded();
    model.push({ facts: {} });
    await lead.say("obrigada!");
    const briefing = model.briefings.at(-1) ?? "";
    assert.match(briefing, /UMA frase curta e calorosa de despedida/, "a close");
    assert.doesNotMatch(briefing, /lembre o que fica marcado/, "without the schedule again");
  });

  await t.test("'não vou mais poder' is 009's cancel, asked first", async () => {
    const { lead, id } = await reminded();
    model.push({ facts: { changeRequest: "cancel" } }, { facts: { answer: "yes" } });
    const ask = await lead.say("não vou mais poder");
    assert.match(ask.reply, /^Quer mesmo cancelar a visita ao VMA-0001 de sex/);
    await lead.say("sim");
    assert.equal(await status(id), "cancelled");
    const [pending] = await query(
      "select count(*)::int as n from followup_jobs where appointment_id = $1 and status = 'pending'",
      [id],
    );
    assert.equal(pending.n, 0, "the reminder of a cancelled meeting is gone");
  });

  await t.test("'pode ser outro dia?' is 009's reschedule, with options", async () => {
    const { lead } = await reminded();
    model.push({ facts: { changeRequest: "reschedule" } });
    const reply = await lead.say("pode ser outro dia?");
    assert.match(reply.reply, /^Para remarcar a visita ao VMA-0001, tenho estes horários/);
  });

  await t.test("'para de me mandar mensagem' is the opt-out, and the meeting stands", async () => {
    const { lead, id } = await reminded();
    model.push({ facts: { optOut: true } });
    await lead.say("para de me mandar mensagem");
    const [row] = await query("select do_not_contact from leads where id = $1", [lead.leadId]);
    assert.equal(row.do_not_contact, true);
    assert.equal(await status(id), "confirmed", "opting out does not cancel the visit (spec 017)");
  });
});
