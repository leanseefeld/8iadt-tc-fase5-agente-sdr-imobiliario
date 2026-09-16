import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closePool, getDb, getPool } from "../../src/db/client.ts";
import { collectingSink, runTurn } from "../../src/agent/orchestrator.ts";
import { recordLeadMessage } from "../../src/services/conversation.ts";
import { unansweredTurns } from "../../src/jobs/unanswered-turns.ts";
import { createLogger } from "../../src/core/logging.ts";
import { getConfig } from "../../src/core/config.ts";

/**
 * INTEGRATION=1 — the turn's durability rules (T056).
 *
 * SC-008 (the same message identifier twice is one message and one reply), the
 * two refusals that cost no model call (FR-032's budget and length), and FR-046:
 * a turn abandoned by a dead replica is re-run by the worker's sweep from the
 * rows alone.
 *
 * SC-009, the provider outage, is `provider-outage.test.ts` — it needs the
 * configuration to name a dead provider, and configuration is parsed once per
 * process.
 */
const integration = process.env.INTEGRATION === "1";

const AGENCY = "demo";

interface Row {
  [column: string]: unknown;
}

async function query(sql: string, params: unknown[] = []): Promise<Row[]> {
  const result = await getPool().query(sql, params);
  return result.rows as Row[];
}

async function cleanUp(conversationId: string, leadId: string): Promise<void> {
  await query("delete from events where conversation_id = $1", [conversationId]);
  await query("delete from messages where conversation_id = $1", [conversationId]);
  await query("delete from conversations where id = $1", [conversationId]);
  await query("delete from leads where id = $1", [leadId]);
}

test("the same clientMessageId twice is one message and one reply (SC-008)", { skip: !integration }, async (t) => {
  const sessionId = `test-${randomUUID()}`;
  const clientMessageId = randomUUID();
  const inbound = {
    agencySlug: AGENCY,
    externalId: sessionId,
    clientMessageId,
    text: "Quero comprar um apartamento na zona sul",
    consent: true,
  };

  const first = await recordLeadMessage(inbound);
  assert.equal(first.status, "stored");
  assert.ok("conversationId" in first);

  const second = await recordLeadMessage(inbound);
  assert.equal(second.status, "duplicate", JSON.stringify(second));

  const result = await runTurn({ conversationId: first.conversationId, sink: collectingSink() });
  assert.equal(result.status, "committed");

  await t.test("one lead row and one agent row", async () => {
    const rows = await query(
      "select role, count(*)::int as n from messages where conversation_id = $1 group by role",
      [first.conversationId],
    );
    const byRole = Object.fromEntries(rows.map((row) => [row.role, row.n]));
    assert.equal(byRole.lead, 1, JSON.stringify(byRole));
    assert.equal(byRole.agent, 1, JSON.stringify(byRole));
  });

  await t.test("a turn re-run after the reply answers nothing new", async () => {
    const again = await runTurn({ conversationId: first.conversationId, sink: collectingSink() });
    assert.equal(again.status, "skipped");
    assert.ok(again.status === "skipped" && again.reason === "nothingUnanswered");
  });

  t.after(() => cleanUp(first.conversationId, first.leadId));
});

test("the budget and the length refuse without a model call (FR-032)", { skip: !integration }, async (t) => {
  const sessionId = `test-${randomUUID()}`;
  const config = getConfig();

  const opening = await recordLeadMessage({
    agencySlug: AGENCY,
    externalId: sessionId,
    clientMessageId: randomUUID(),
    text: "oi",
    consent: true,
  });
  assert.ok("conversationId" in opening);
  const { conversationId, leadId } = opening;

  await t.test("a message longer than the cap is refused and not stored", async () => {
    const before = await query("select count(*)::int as n from messages where conversation_id = $1", [conversationId]);

    const refused = await recordLeadMessage({
      agencySlug: AGENCY,
      externalId: sessionId,
      clientMessageId: randomUUID(),
      text: "a".repeat(config.CHAT_MAX_MESSAGE_CHARS + 1),
      consent: true,
    });

    assert.equal(refused.status, "rejected");
    assert.ok(refused.status === "rejected" && refused.reason === "tooLong");

    const after = await query("select count(*)::int as n from messages where conversation_id = $1", [conversationId]);
    assert.equal(after[0].n, before[0].n, "the refused message was stored");
  });

  await t.test("a session over its budget is refused and not stored", async () => {
    // The budget counts lead messages in the window, so the window is filled
    // directly: sending `CHAT_MESSAGE_BUDGET` real messages would cost as many
    // model calls to prove something no model is involved in.
    await query(
      `insert into messages (conversation_id, role, content)
       select $1::uuid, 'lead', 'enchendo a janela' from generate_series(1, $2)`,
      [conversationId, config.CHAT_MESSAGE_BUDGET],
    );

    const refused = await recordLeadMessage({
      agencySlug: AGENCY,
      externalId: sessionId,
      clientMessageId: randomUUID(),
      text: "mais uma",
      consent: true,
    });

    assert.equal(refused.status, "rejected");
    assert.ok(refused.status === "rejected" && refused.reason === "budget");

    const rows = await query(
      "select count(*)::int as n from messages where conversation_id = $1 and content = 'mais uma'",
      [conversationId],
    );
    assert.equal(rows[0].n, 0, "the refused message was stored");
  });

  t.after(() => cleanUp(conversationId, leadId));
});

test("a turn abandoned mid-flight is re-run by the sweep (FR-046)", { skip: !integration }, async (t) => {
  const sessionId = `test-${randomUUID()}`;
  const inbound = await recordLeadMessage({
    agencySlug: AGENCY,
    externalId: sessionId,
    clientMessageId: randomUUID(),
    text: "Quero alugar um apartamento de 2 quartos",
    consent: true,
  });
  assert.ok("conversationId" in inbound);
  const { conversationId, leadId } = inbound;

  // The replica that died: it claimed the turn and never came back. The claim is
  // older than `MODEL_TIMEOUT_MS × 2`, and the lead message is older than the
  // debounce, which together are what make the row eligible again.
  await query(
    `update conversations set processing_since = now() - interval '1 hour' where id = $1`,
    [conversationId],
  );
  await query(
    `update messages set created_at = now() - interval '1 hour' where conversation_id = $1`,
    [conversationId],
  );

  await unansweredTurns.run({
    db: getDb(),
    now: new Date(),
    log: createLogger("worker", { module: "test" }),
  });

  await t.test("the lead has an answer, written by the sweep", async () => {
    const rows = await query(
      "select role, content from messages where conversation_id = $1 order by created_at",
      [conversationId],
    );
    assert.equal(rows.length, 2, JSON.stringify(rows));
    assert.equal(rows[1].role, "agent");
    assert.ok(String(rows[1].content).length > 0);
  });

  await t.test("the claim was released", async () => {
    const [row] = await query("select processing_since from conversations where id = $1", [conversationId]);
    assert.equal(row.processing_since, null);
  });

  t.after(async () => {
    await cleanUp(conversationId, leadId);
    await closePool();
  });
});
