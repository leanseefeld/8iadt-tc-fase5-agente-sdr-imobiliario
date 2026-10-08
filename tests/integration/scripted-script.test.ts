import test from "node:test";
import assert from "node:assert/strict";
import { closePool } from "../../src/db/client.ts";
import { EMPTY_SLOTS } from "../../src/domain/slots.ts";
import { useScriptedModel } from "../support/scripted-model.ts";
import { READY, qualifiedLead, query, type Lead } from "./support/meeting.ts";

/**
 * The qualification script with a hosted model that reads differently from
 * e4b: it hands the answer back as "what nothing captured", and sometimes reads
 * nothing at all from a one-word answer. The developer's Azure tests of 08/10.
 */
const integration = process.env.INTEGRATION === "1";

async function setState(lead: Lead, intent: string, slots: Record<string, unknown>): Promise<void> {
  await query("update leads set intent = $2 where id = $1", [lead.leadId, intent]);
  await query("update conversations set slots = $2::jsonb where id = $1", [
    lead.conversationId,
    JSON.stringify({ ...EMPTY_SLOTS, ...slots }),
  ]);
}

test("the script, scripted", { skip: !integration }, async (t) => {
  const model = useScriptedModel();
  const leads: Lead[] = [];
  const lead = async () => {
    const created = await qualifiedLead();
    leads.push(created);
    return created;
  };
  t.after(async () => {
    model.restore();
    for (const created of leads) await created.cleanup();
    await closePool();
  });

  await t.test("an answer the model also calls 'uncovered' is an answer, not a matter for the team", async () => {
    const bia = await lead();
    await setState(bia, "rental", { priceMax: 6500 });
    model.push({ facts: { bedrooms: 2, uncovered: "2", messageAct: "inform" } });
    const reply = await bia.say("2");
    assert.equal((await bia.lastMetadata()).humanOffer, undefined);
    assert.equal(reply.handoffReason, null);
  });

  await t.test("'alugar' answers 'comprar, alugar ou investir?' even when the model read nothing", async () => {
    const cid = await lead();
    await setState(cid, "undefined", {});
    model.push({ facts: { messageAct: "other" } });
    await cid.say("alugar");
    const [row] = await query("select intent from leads where id = $1", [cid.leadId]);
    assert.equal(row.intent, "rental");
  });

  await t.test("'só olhando' answers the prazo question even when the model only echoed the bairro", async () => {
    const dani = await lead();
    await setState(dani, "purchase", { ...READY, urgency: null, name: null, contact: null });
    model.push({ facts: { neighborhoods: ["Vila Mariana"], messageAct: "inform" } });
    const reply = await dani.say("só olhando");
    const [row] = await query("select slots from conversations where id = $1", [dani.conversationId]);
    assert.equal((row.slots as { urgency: string }).urgency, "exploring");
    assert.equal(reply.handoffReason, null);
  });
});
