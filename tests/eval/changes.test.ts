import test from "node:test";
import assert from "node:assert/strict";
import { closePool } from "../../src/db/client.ts";
import { MEETING_LIMIT_SENTENCE } from "../../src/agent/prompts/meeting.ts";
import { localParts } from "../../src/domain/scheduling.ts";
import { bookDirect, nextLocal, qualifiedLead, query, type Lead } from "../integration/support/meeting.ts";

/**
 * INTEGRATION=1, local model — spec 009's seven examples, one each. What the
 * lead already booked is written straight to the test database; the
 * conversation under test goes through the real turn.
 */
const integration = process.env.INTEGRATION === "1";
const TZ = "America/Sao_Paulo";

async function status(id: string): Promise<{ status: string; scheduled_at: Date }> {
  const [row] = await query("select status, scheduled_at from appointments where id = $1", [id]);
  return row as never;
}

test("changing what was booked", { skip: !integration }, async (t) => {
  const leads: Lead[] = [];
  const lead = async () => {
    const created = await qualifiedLead({ brokerName: "Ana Ribeiro" });
    leads.push(created);
    return created;
  };
  const facts = async (created: Lead) => JSON.stringify((await created.lastMetadata()).toolCalls);
  t.after(async () => {
    for (const created of leads) await created.cleanup();
    await closePool();
  });

  await t.test("1 · cancel, confirmed: asks first, cancels on yes, offers to rebook", async () => {
    const bia = await lead();
    const id = await bookDirect(bia, { at: nextLocal("fri", 14), propertyCode: "VMA-0001" });
    const ask = await bia.say("não vou mais poder na sexta");
    assert.match(ask.reply, /^Quer mesmo cancelar a visita ao VMA-0001 de sex/, await facts(bia));
    assert.equal((await status(id)).status, "confirmed", "nothing before the yes");
    const done = await bia.say("sim, pode cancelar");
    assert.match(done.reply, /^Pronto, cancelei a visita ao VMA-0001 .* Quer marcar outro dia\?$/, await facts(bia));
    assert.equal((await status(id)).status, "cancelled");
  });

  await t.test("2 · cancel, not confirmed: the visit stands", async () => {
    const leo = await lead();
    const id = await bookDirect(leo, { at: nextLocal("fri", 14), propertyCode: "VMA-0001" });
    await leo.say("preciso cancelar a visita");
    const kept = await leo.say("não, deixa");
    assert.match(kept.reply, /^Tudo certo, a visita ao VMA-0001 .* continua marcada\.$/, await facts(leo));
    assert.equal((await status(id)).status, "confirmed");
  });

  await t.test("3 · reschedule to a named time: the same meeting moves", async () => {
    const rafa = await lead();
    const id = await bookDirect(rafa, { at: nextLocal("fri", 14), propertyCode: "VMA-0001" });
    const moved = await rafa.say("dá pra passar pra segunda às 10?");
    assert.match(moved.reply, /^Pronto! Sua visita ao VMA-0001 foi remarcada para seg .* às 10h/, await facts(rafa));
    const row = await status(id);
    assert.equal(row.status, "confirmed");
    const local = localParts(new Date(row.scheduled_at), TZ);
    assert.equal(local.weekday, "mon");
    assert.equal(local.minutes, 10 * 60);
    const [count] = await query("select count(*)::int as n from appointments where conversation_id = $1", [rafa.conversationId]);
    assert.equal(count.n, 1, "moved, not duplicated");
  });

  await t.test("4 · reschedule that doesn't fit: why, and options for that meeting", async () => {
    const paulo = await lead();
    const at = nextLocal("fri", 14);
    const id = await bookDirect(paulo, { at, propertyCode: "VMA-0001" });
    const refused = await paulo.say("quero remarcar pra daqui a meia hora");
    assert.match(refused.reply, /Para remarcar a visita ao VMA-0001, tenho estes horários/, await facts(paulo));
    assert.equal(new Date((await status(id)).scheduled_at).getTime(), at.getTime(), "still where it was");
  });

  await t.test("5 · which one: asks, then acts on the answer", async () => {
    const camila = await lead();
    await bookDirect(camila, { at: nextLocal("fri", 14), propertyCode: "VMA-0001" });
    const tue = await bookDirect(camila, { at: nextLocal("tue", 10), propertyCode: "MOE-0008" });
    const which = await camila.say("quero cancelar a visita");
    assert.match(which.reply, /^Qual delas: .*VMA-0001.* ou .*MOE-0008/, await facts(camila));
    const ask = await camila.say("a de terça");
    assert.match(ask.reply, /^Quer mesmo cancelar a visita ao MOE-0008/, await facts(camila));
    assert.equal((await status(tue)).status, "confirmed");
  });

  await t.test("6 · a second meeting: phone options, both stand", async () => {
    const duda = await lead();
    const visit = await bookDirect(duda, { at: nextLocal("fri", 14), propertyCode: "VMA-0001" });
    const offer = await duda.say("quero também uma conversa por telefone");
    assert.match(offer.reply, /Tenho estes horários para uma conversa por telefone/, await facts(duda));
    const booked = await duda.say("pode ser a primeira opção");
    assert.match(booked.reply, /^Pronto! Sua conversa por telefone está confirmada/, await facts(duda));
    assert.equal((await status(visit)).status, "confirmed");
    const [count] = await query(
      "select count(*)::int as n from appointments where lead_id = $1 and status = 'confirmed'",
      [duda.leadId],
    );
    assert.equal(count.n, 2);
  });

  await t.test("7 · the limit: three booked, a fourth is refused with the offer to change one", async () => {
    const gabi = await lead();
    await bookDirect(gabi, { at: nextLocal("mon", 10), propertyCode: "VMA-0001" });
    await bookDirect(gabi, { at: nextLocal("tue", 10), propertyCode: "MOE-0008" });
    await bookDirect(gabi, { at: nextLocal("wed", 10) });
    const fourth = await gabi.say("quero marcar mais uma conversa por telefone");
    assert.equal(fourth.reply, MEETING_LIMIT_SENTENCE, await facts(gabi));
  });
});
