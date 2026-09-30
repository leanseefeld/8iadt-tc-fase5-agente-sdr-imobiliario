import test from "node:test";
import assert from "node:assert/strict";
import { closePool } from "../../src/db/client.ts";
import { useScriptedModel } from "../support/scripted-model.ts";
import { bookDirect, nextLocal, qualifiedLead, query, type Lead } from "./support/meeting.ts";

/**
 * The code's meeting decisions, with the model scripted: the extraction reads
 * what each case says it read, so a failure here is the code's, never the
 * sampler's. Postgres-backed (the test database), no model, a few seconds.
 */
const integration = process.env.INTEGRATION === "1";

async function status(id: string): Promise<string> {
  const [row] = await query("select status from appointments where id = $1", [id]);
  return row.status as string;
}

test("meeting decisions, scripted", { skip: !integration }, async (t) => {
  const model = useScriptedModel();
  const leads: Lead[] = [];
  const lead = async () => {
    const created = await qualifiedLead({ brokerName: "Ana Ribeiro" });
    leads.push(created);
    return created;
  };
  t.after(async () => {
    model.restore();
    for (const created of leads) await created.cleanup();
    await closePool();
  });

  await t.test("cancel asks first, cancels on yes, offers to rebook (009 example 1)", async () => {
    const bia = await lead();
    const id = await bookDirect(bia, { at: nextLocal("fri", 14), propertyCode: "VMA-0001" });
    model.push({ facts: { changeRequest: "cancel", preferredWeekday: "fri" } }, { facts: { answer: "yes" } });
    const ask = await bia.say("não vou mais poder na sexta");
    assert.match(ask.reply, /^Quer mesmo cancelar a visita ao VMA-0001 de sex/);
    assert.equal(await status(id), "confirmed", "nothing before the yes");
    const done = await bia.say("sim, pode cancelar");
    assert.match(done.reply, /cancelei a visita ao VMA-0001/);
    assert.equal(await status(id), "cancelled");
  });

  await t.test("a no read from the words keeps the visit (009 example 2)", async () => {
    const leo = await lead();
    const id = await bookDirect(leo, { at: nextLocal("fri", 14), propertyCode: "VMA-0001" });
    // The extraction reads nothing on the second message: the code reads "não, deixa".
    model.push({ facts: { changeRequest: "cancel" } }, { facts: {} });
    await leo.say("preciso cancelar a visita");
    const kept = await leo.say("não, deixa");
    assert.match(kept.reply, /continua marcada/);
    assert.equal(await status(id), "confirmed");
  });

  await t.test("a thank-you after booking closes with the summary; a second one is short", async () => {
    const ana = await lead();
    await bookDirect(ana, { at: nextLocal("mon", 10), propertyCode: "MOE-0001" });
    model.push({ facts: {} }, { facts: {} });
    const first = await ana.say("obrigado!");
    assert.match(first.reply, /Fica marcado: a visita ao MOE-0001/);
    const second = await ana.say("valeu!");
    assert.doesNotMatch(second.reply, /Fica marcado/);
  });
});
