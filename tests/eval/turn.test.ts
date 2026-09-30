import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closePool, getPool } from "../../src/db/client.ts";
import { collectingSink, runTurn } from "../../src/agent/orchestrator.ts";
import { recordLeadMessage } from "../../src/services/conversation.ts";
import { checkReply, splitSentences } from "../../src/domain/reply-guards.ts";
import { PRE_CONSENT_REPLY } from "../../src/agent/prompts/fallback.ts";

/**
 * INTEGRATION=1 — the group B exit gate: one real turn, through
 * `services/conversation.ts` and `agent/orchestrator.ts`, against the local
 * model and the seeded database, persisted.
 *
 * It is the first message of Cenário 1 and asserts US1 scenario 1 (FR-001 to
 * FR-008), FR-012's guards on what the model actually wrote, FR-044's
 * `repliesToMessageId`, and the event catalog of `data-model.md` §4. The second
 * case is FR-019: text sent before "Aceito" costs no model call and is not a turn.
 *
 * Slow by design — two model calls per turn on a 4-bit model.
 */
const integration = process.env.INTEGRATION === "1";

const AGENCY = "demo";
const FIRST_MESSAGE = "Estou procurando apartamento na zona sul";

interface Row {
  [column: string]: unknown;
}

async function query(sql: string, params: unknown[] = []): Promise<Row[]> {
  const result = await getPool().query(sql, params);
  return result.rows as Row[];
}

test("one turn runs end to end and persists (US1 scenario 1)", { skip: !integration }, async (t) => {
  const sessionId = `test-${randomUUID()}`;

  const inbound = await recordLeadMessage({
    agencySlug: AGENCY,
    externalId: sessionId,
    clientMessageId: randomUUID(),
    text: FIRST_MESSAGE,
    consent: true,
  });

  assert.equal(inbound.status, "stored");
  assert.ok("conversationId" in inbound);
  const { conversationId, leadId, messageId: leadMessageId } = inbound;

  const sink = collectingSink();
  const result = await runTurn({ conversationId, sink });

  await t.test("the turn committed", () => {
    assert.equal(result.status, "committed", JSON.stringify(result));
  });
  assert.ok(result.status === "committed");

  await t.test("the intent is purchase and the region was captured", () => {
    assert.equal(result.intent, "purchase");
    assert.deepEqual(
      result.slots.neighborhoods === null ? null : result.slots.neighborhoods.length > 0,
      true,
      `neighborhoods: ${JSON.stringify(result.slots.neighborhoods)}`,
    );
  });

  await t.test("the reply asks the first unfilled slot of the purchase script", () => {
    assert.equal(result.question?.slot, "priceMax");
    assert.ok(result.reply.length > 0, "the reply is empty");
    assert.ok(result.reply.includes("?"), `no question in: ${result.reply}`);
  });

  await t.test("the reply passes the guards it was streamed through (FR-012)", () => {
    const verdict = checkReply(result.reply, {
      pendingSlot: "priceMax",
      nextSlot: "bedrooms",
      allowedAmounts: [],
      allowedPercentages: [],
    });
    assert.equal(verdict.ok, true, JSON.stringify(verdict));

    const questions = splitSentences(result.reply).filter((s) => s.includes("?"));
    assert.ok(questions.length <= 2, `${questions.length} questions: ${result.reply}`);
  });

  await t.test("the reply reached the sink as sentence chunks (FR-017)", () => {
    assert.ok(sink.chunks.length > 0);
    assert.equal(sink.text().trim(), result.reply);
  });

  await t.test("the agent message points at the lead message it answered (FR-044)", async () => {
    const [row] = await query(
      "select id, role, content, replies_to_message_id from messages where id = $1",
      [result.messageId],
    );
    assert.equal(row.role, "agent");
    assert.equal(row.replies_to_message_id, leadMessageId);
    assert.equal(row.content, result.reply);
  });

  await t.test("the lead row carries the identified intent", async () => {
    const [row] = await query("select intent, status, score from leads where id = $1", [leadId]);
    assert.equal(row.intent, "purchase");
    assert.equal(row.status, "qualifying");
  });

  await t.test("the slot state was written to the conversation", async () => {
    const [row] = await query(
      "select slots, processing_since, last_agent_message_at from conversations where id = $1",
      [conversationId],
    );
    assert.deepEqual(row.slots, result.slots);
    // The claim is released inside the same transaction that commits the turn.
    assert.equal(row.processing_since, null);
    assert.notEqual(row.last_agent_message_at, null);
  });

  await t.test("the catalog events exist, all attributed to the agent", async () => {
    const rows = await query(
      "select type, actor_type, actor_user_id from events where conversation_id = $1",
      [conversationId],
    );
    const types = rows.map((row) => row.type);
    for (const expected of ["lead.created", "intent.identified", "conversation.turn"]) {
      assert.ok(types.includes(expected), `missing ${expected} in ${JSON.stringify(types)}`);
    }
    for (const row of rows) {
      assert.equal(row.actor_type, "agent");
      assert.equal(row.actor_user_id, null);
    }
  });

  await t.test("a repeated clientMessageId stores nothing new (FR-035)", async () => {
    const clientMessageId = randomUUID();
    const first = await recordLeadMessage({
      agencySlug: AGENCY,
      externalId: sessionId,
      clientMessageId,
      text: "Até uns 700 mil",
    });
    const second = await recordLeadMessage({
      agencySlug: AGENCY,
      externalId: sessionId,
      clientMessageId,
      text: "Até uns 700 mil",
    });

    assert.equal(first.status, "stored");
    assert.equal(second.status, "duplicate");

    const [row] = await query(
      "select count(*)::int as n from messages where conversation_id = $1 and metadata->>'clientMessageId' = $2",
      [conversationId, clientMessageId],
    );
    assert.equal(row.n, 1);
  });
});

test("a message before consent costs no model call and is not a turn (FR-019)", { skip: !integration }, async (t) => {
  const sessionId = `test-preconsent-${randomUUID()}`;

  const inbound = await recordLeadMessage({
    agencySlug: AGENCY,
    externalId: sessionId,
    clientMessageId: randomUUID(),
    text: "oi, quero ver apartamentos",
  });

  await t.test("nothing is stored and the caller is told why", () => {
    assert.deepEqual(inbound, { status: "rejected", reason: "consent" });
  });

  await t.test("no lead, no conversation, no message was created", async () => {
    const [row] = await query("select count(*)::int as n from leads where external_id = $1", [
      sessionId,
    ]);
    assert.equal(row.n, 0);
  });

  await t.test("the orchestrator's own gate answers with the template", async () => {
    // The same lead, now consented but with `consentAt` cleared underneath the
    // turn — the state the worker's consumer can reach without passing through
    // `recordLeadMessage`. No model is called and no turn is persisted.
    const consented = await recordLeadMessage({
      agencySlug: AGENCY,
      externalId: sessionId,
      clientMessageId: randomUUID(),
      text: "quero ver apartamentos",
      consent: true,
    });
    assert.ok("conversationId" in consented);
    await query("update leads set consent_at = null where id = $1", [consented.leadId]);

    const sink = collectingSink();
    const before = await query("select count(*)::int as n from messages where conversation_id = $1", [
      consented.conversationId,
    ]);
    const result = await runTurn({ conversationId: consented.conversationId, sink });
    const after = await query("select count(*)::int as n from messages where conversation_id = $1", [
      consented.conversationId,
    ]);

    assert.equal(result.status, "skipped");
    assert.equal(result.status === "skipped" ? result.reason : null, "preConsent");
    assert.equal(sink.text(), PRE_CONSENT_REPLY);
    assert.equal(after[0].n, before[0].n, "a turn was persisted before consent");
  });
});

test.after(async () => {
  await closePool();
});
