import test from "node:test";
import assert from "node:assert/strict";
import { closePool } from "../../src/db/client.ts";
import { EMPTY_SLOTS } from "../../src/domain/slots.ts";
import { useScriptedModel } from "../support/scripted-model.ts";
import { READY, qualifiedLead, query, type Lead } from "./support/meeting.ts";

/**
 * ADR 26: `events` is the outbox a CRM connector reads, so a `slot.filled`
 * row carries the lead's name and contact as the lead gave them. Traces and
 * logs stay masked (`masking.test.ts`, `span-mask.test.ts`); so does the
 * tool-call copy on the message row, which no integration reads.
 */
const integration = process.env.INTEGRATION === "1";

async function slotEvents(lead: Lead): Promise<Array<{ slot: string; value: unknown }>> {
  const rows = await query(
    "select payload from events where conversation_id = $1 and type = 'slot.filled' order by created_at, id",
    [lead.conversationId],
  );
  return rows.map((row) => row.payload as { slot: string; value: unknown });
}

test("slot.filled events carry the real name and contact", { skip: !integration }, async (t) => {
  const model = useScriptedModel();
  const leads: Lead[] = [];
  t.after(async () => {
    model.restore();
    for (const created of leads) await created.cleanup();
    await closePool();
  });

  const lead = await qualifiedLead();
  leads.push(lead);
  await query("update conversations set slots = $2::jsonb where id = $1", [
    lead.conversationId,
    JSON.stringify({ ...EMPTY_SLOTS, ...READY, name: null, contact: null }),
  ]);

  await t.test("the name, unmasked", async () => {
    model.push({ facts: { name: "Camila Duarte", messageAct: "inform" } });
    await lead.say("Camila Duarte");
    const name = (await slotEvents(lead)).find((event) => event.slot === "name");
    assert.deepEqual(name, { slot: "name", value: "Camila Duarte" });
  });

  await t.test("the phone, unmasked and as written", async () => {
    model.push({ facts: { contact: "(11) 98765-4321", messageAct: "inform" } });
    await lead.say("(11) 98765-4321");
    const contact = (await slotEvents(lead)).find((event) => event.slot === "contact");
    assert.deepEqual(contact, { slot: "contact", value: "(11) 98765-4321" });
  });

  await t.test("the tool-call copy on the message stays masked", async () => {
    const rows = await query(
      "select metadata from messages where conversation_id = $1 and role = 'agent' and metadata ? 'toolCalls'",
      [lead.conversationId],
    );
    const written = JSON.stringify(rows.map((row) => row.metadata));
    assert.ok(written.includes("updateSlots"), written);
    assert.ok(!written.includes("Duarte"), written);
    assert.ok(!written.includes("98765"), written);
  });
});
