import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closePool, getPool } from "../../src/db/client.ts";
import { collectingSink, runTurn } from "../../src/agent/orchestrator.ts";
import { recordLeadMessage } from "../../src/services/conversation.ts";

/**
 * INTEGRATION=1 — SC-001, and the search half of a revision (SC-003 partial).
 *
 * The purchase script is already complete in the row, so this turn is only the
 * revision. Contact is left empty on purpose: a hot lead with a phone is offered
 * a meeting, and that offer currently suppresses the search.
 */
const integration = process.env.INTEGRATION === "1";

const QUALIFIED = {
  priceMax: 700_000,
  bedrooms: 2,
  neighborhoods: ["Moema"],
  urgency: "exploring",
  investorProfile: null,
  ticket: null,
  returnExpectation: null,
  name: null,
  contact: null,
};

interface Row {
  [column: string]: unknown;
}

async function query(sql: string, params: unknown[] = []): Promise<Row[]> {
  const result = await getPool().query(sql, params);
  return result.rows as Row[];
}

test(
  "a revision after qualification changes the slot, resets the streak and searches again",
  { skip: !integration },
  async () => {
    const sessionId = `test-${randomUUID()}`;
    const inbound = await recordLeadMessage({
      agencySlug: "demo",
      externalId: sessionId,
      clientMessageId: randomUUID(),
      text: "Estou procurando apartamento na zona sul",
      consent: true,
    });
    assert.equal(inbound.status, "stored");
    assert.ok("conversationId" in inbound);
    const { conversationId, leadId } = inbound;

    // The opening line is already answered, so the turn under test reads only
    // the revision. The row is where a finished purchase script leaves it, with
    // a streak already at 1 so a hold and a reset are distinguishable.
    await query(
      "insert into messages (conversation_id, role, content) values ($1, 'agent', $2)",
      [conversationId, "Anotei: zona sul, até 700 mil, 2 quartos."],
    );
    await query("update leads set intent = 'purchase', status = 'qualified', score = 70 where id = $1", [
      leadId,
    ]);
    await query(
      "update conversations set slots = $2::jsonb, fallback_streak = 1 where id = $1",
      [conversationId, JSON.stringify(QUALIFIED)],
    );

    const revision = await recordLeadMessage({
      agencySlug: "demo",
      externalId: sessionId,
      clientMessageId: randomUUID(),
      text: "na verdade, e na zona norte?",
      consent: true,
    });
    assert.equal(revision.status, "stored");

    const result = await runTurn({ conversationId, sink: collectingSink() });
    assert.equal(result.status, "committed", JSON.stringify(result));
    assert.ok(result.status === "committed");

    const neighborhoods = result.slots.neighborhoods;
    assert.ok(Array.isArray(neighborhoods) && neighborhoods.length > 0, JSON.stringify(neighborhoods));
    assert.equal(neighborhoods.includes("Moema"), false, `neighborhoods stayed ${JSON.stringify(neighborhoods)}`);
    assert.equal(result.handoffReason, null, result.reply);
    assert.equal(/não entendi/i.test(result.reply), false, result.reply);
    assert.ok(result.propertyCodes.length > 0, `no search ran: ${result.reply}`);
    assert.ok(result.events.includes("slot.filled"), JSON.stringify(result.events));

    const [row] = await query("select fallback_streak from conversations where id = $1", [conversationId]);
    assert.equal(row.fallback_streak, 0);

    await query("delete from events where conversation_id = $1", [conversationId]);
    await query("delete from messages where conversation_id = $1", [conversationId]);
    await query("delete from conversations where id = $1", [conversationId]);
    await query("delete from leads where id = $1", [leadId]);
    await closePool();
  },
);
