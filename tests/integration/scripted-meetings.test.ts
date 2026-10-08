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

  await t.test("the purpose changes only when the message says so (the 'isso' and 'Meu nome é' flips)", async () => {
    const intentOf = async (created: Lead) =>
      (await query("select intent from leads where id = $1", [created.leadId]))[0].intent as string;
    const nina = await lead();
    model.push({ facts: { intent: "rental", messageAct: "agree" } }, { facts: { intent: "rental", name: "Nina" } });
    await nina.say("isso");
    assert.equal(await intentOf(nina), "purchase", "'isso' is not a change of purpose");
    await nina.say("Meu nome é Nina");
    assert.equal(await intentOf(nina), "purchase");
    const otto = await lead();
    model.push({ facts: { intent: "rental" } });
    await otto.say("na verdade quero alugar");
    assert.equal(await intentOf(otto), "rental", "said, so it changes");
  });

  await t.test("a thank-you after booking closes with the summary; a second one is short", async () => {
    const ana = await lead();
    await bookDirect(ana, { at: nextLocal("mon", 10), propertyCode: "MOE-0001" });
    model.push({ facts: {} }, { facts: {} });
    await ana.say("obrigado!");
    assert.match(model.briefings.at(-1) ?? "", /lembre o que fica marcado.*a visita ao MOE-0001/s);
    await ana.say("valeu!");
    assert.doesNotMatch(model.briefings.at(-1) ?? "", /lembre o que fica marcado/, "a second close is the courtesy alone");
  });
});
