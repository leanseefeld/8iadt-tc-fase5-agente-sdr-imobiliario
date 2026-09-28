import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closePool, getPool } from "../../src/db/client.ts";
import { closeNotifier } from "../../src/core/notifier.ts";
import { assumeConversation, returnToAgent } from "../../src/services/handoff.ts";
import { collectingSink, runTurn } from "../../src/agent/orchestrator.ts";
import { recordLeadMessage } from "../../src/services/conversation.ts";
import type { LeadScope } from "../../src/services/auth.ts";

/**
 * INTEGRATION=1 — SC-009. The re-entry line is posted when the broker returns
 * the conversation, before the lead's next message is processed.
 */
const integration = process.env.INTEGRATION === "1";

test("handback posts the re-entry line before the lead writes again", { skip: !integration }, async () => {
  const pool = getPool();
  const { rows: users } = await pool.query<{ id: string; agency_id: string; name: string }>(
    "select id, agency_id, name from users where email = 'ana@demo.com.br'",
  );
  const ana = users[0];
  assert.ok(ana !== undefined);

  const sessionId = `test-handback-${randomUUID()}`;
  const inbound = await recordLeadMessage({
    agencySlug: "demo",
    externalId: sessionId,
    clientMessageId: randomUUID(),
    text: "Quero comprar um apartamento",
    consent: true,
  });
  assert.ok("conversationId" in inbound);
  const { conversationId, leadId } = inbound;

  const scope: LeadScope = { agencyId: ana.agency_id, defaultOwnLeadsOnly: true };
  try {
    assert.deepEqual(await assumeConversation(scope, leadId, ana.id), { ok: true });
    assert.deepEqual(await returnToAgent(scope, leadId, ana.id), { ok: true });

    const { rows: before } = await pool.query<{ content: string; role: string }>(
      "select role, content from messages where conversation_id = $1 order by created_at",
      [conversationId],
    );
    const greeting = before.find((row) => row.role === "agent");
    assert.ok(greeting !== undefined, JSON.stringify(before));
    assert.match(greeting.content, /Sofia de volta!/);
    assert.match(greeting.content, /saiu da conversa/);

    const follow = await recordLeadMessage({
      agencySlug: "demo",
      externalId: sessionId,
      clientMessageId: randomUUID(),
      text: "opa",
      consent: true,
    });
    assert.equal(follow.status, "stored");
    const result = await runTurn({ conversationId, sink: collectingSink() });
    assert.equal(result.status, "committed", JSON.stringify(result));
    assert.ok(result.status === "committed");
    assert.equal(/não entendi/i.test(result.reply), false, result.reply);
    assert.equal(result.handoffReason, null);
  } finally {
    await pool.query("delete from events where conversation_id = $1", [conversationId]);
    await pool.query("delete from messages where conversation_id = $1", [conversationId]);
    await pool.query("delete from appointments where conversation_id = $1", [conversationId]);
    await pool.query("delete from followup_jobs where conversation_id = $1", [conversationId]);
    await pool.query("delete from conversations where id = $1", [conversationId]);
    await pool.query("delete from leads where id = $1", [leadId]);
    await closeNotifier();
    await closePool();
  }
});
