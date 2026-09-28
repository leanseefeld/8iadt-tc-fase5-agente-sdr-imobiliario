import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closePool, getPool } from "../../src/db/client.ts";
import { collectingSink, runTurn } from "../../src/agent/orchestrator.ts";
import { recordLeadMessage } from "../../src/services/conversation.ts";

/**
 * INTEGRATION=1 — SC-008. A finished purchase script with a phone already
 * offers a viewing. Three further messages must not offer it again.
 */
const integration = process.env.INTEGRATION === "1";

const READY = {
  priceMax: 700_000,
  bedrooms: 2,
  neighborhoods: ["Moema"],
  urgency: "immediate",
  investorProfile: null,
  ticket: null,
  returnExpectation: null,
  name: "Camila",
  contact: "11987654321",
};

async function query(sql: string, params: unknown[] = []) {
  const result = await getPool().query(sql, params);
  return result.rows as Array<Record<string, unknown>>;
}

test("a finished script offers a meeting once across three messages", { skip: !integration }, async () => {
  const sessionId = `test-${randomUUID()}`;
  const inbound = await recordLeadMessage({
    agencySlug: "demo",
    externalId: sessionId,
    clientMessageId: randomUUID(),
    text: "Quero comprar",
    consent: true,
  });
  assert.ok("conversationId" in inbound);
  const { conversationId, leadId } = inbound;

  await query("insert into messages (conversation_id, role, content) values ($1, 'agent', $2)", [
    conversationId,
    "Anotei o que você procura.",
  ]);
  await query("update leads set intent = 'purchase', status = 'qualified', score = 100 where id = $1", [
    leadId,
  ]);
  await query("update conversations set slots = $2::jsonb, fallback_streak = 0 where id = $1", [
    conversationId,
    JSON.stringify(READY),
  ]);

  const offers: Array<string | null> = [];
  try {
    for (const text of ["ok", "beleza", "valeu"]) {
      const message = await recordLeadMessage({
        agencySlug: "demo",
        externalId: sessionId,
        clientMessageId: randomUUID(),
        text,
        consent: true,
      });
      assert.equal(message.status, "stored");
      const result = await runTurn({ conversationId, sink: collectingSink() });
      assert.equal(result.status, "committed", JSON.stringify(result));
      assert.ok(result.status === "committed");
      offers.push(result.meeting);
      assert.equal(result.handoffReason, null, result.reply);
    }

    assert.deepEqual(offers, ["viewing", null, null]);
  } finally {
    await query("delete from events where conversation_id = $1", [conversationId]);
    await query("delete from messages where conversation_id = $1", [conversationId]);
    await query("delete from conversations where id = $1", [conversationId]);
    await query("delete from leads where id = $1", [leadId]);
    await closePool();
  }
});
