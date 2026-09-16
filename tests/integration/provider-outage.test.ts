import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/**
 * INTEGRATION=1 — SC-009: with the provider gone, the lead still gets an answer,
 * and the conversation keeps working once it comes back.
 *
 * Its own file because of one line: the provider has to be unreachable, and
 * `getConfig` parses the environment once per process. The imports below are
 * therefore dynamic — an ESM `import` statement is hoisted above any assignment,
 * so a static one would load `core/config` with the real provider address before
 * this line ran. Node's test runner gives each file its own process, so nothing
 * else in the suite sees this.
 */
const integration = process.env.INTEGRATION === "1";

// Port 9 is the discard protocol: a connection there fails immediately rather
// than hanging, which keeps the test honest about the fallback and quick.
const DEAD_PROVIDER = "http://127.0.0.1:9/v1";

test("a dead provider still answers the lead (SC-009)", { skip: !integration }, async (t) => {
  process.env.PROVIDER_BASE_URL = DEAD_PROVIDER;

  const { closePool, getPool } = await import("../../src/db/client.ts");
  const { collectingSink, runTurn } = await import("../../src/agent/orchestrator.ts");
  const { recordLeadMessage } = await import("../../src/services/conversation.ts");
  const { MODEL_FAILURE_REPLY } = await import("../../src/agent/prompts/fallback.ts");
  const { getConfig } = await import("../../src/core/config.ts");

  assert.equal(getConfig().PROVIDER_BASE_URL, DEAD_PROVIDER, "the dead provider did not take");

  const query = async (sql: string, params: unknown[] = []) =>
    (await getPool().query(sql, params)).rows as Array<Record<string, unknown>>;

  const sessionId = `test-${randomUUID()}`;
  const inbound = await recordLeadMessage({
    agencySlug: "demo",
    externalId: sessionId,
    clientMessageId: randomUUID(),
    text: "Quero comprar um apartamento na zona sul",
    consent: true,
  });
  assert.ok("conversationId" in inbound);
  const { conversationId, leadId } = inbound;

  const sink = collectingSink();
  const startedAt = Date.now();
  const result = await runTurn({ conversationId, sink });
  const elapsed = Date.now() - startedAt;

  await t.test("the turn commits rather than throwing", () => {
    assert.equal(result.status, "committed", JSON.stringify(result));
  });
  assert.ok(result.status === "committed");

  await t.test("the lead gets the written apology, not silence", () => {
    assert.equal(result.reply, MODEL_FAILURE_REPLY);
    assert.equal(sink.text().trim(), MODEL_FAILURE_REPLY);
  });

  await t.test("it arrives inside the configured timeout and retries (FR-014)", () => {
    const config = getConfig();
    const bound = config.MODEL_TIMEOUT_MS * (config.MODEL_MAX_RETRIES + 1);
    assert.ok(elapsed < bound + 5_000, `${elapsed}ms exceeds the ${bound}ms bound`);
  });

  await t.test("the apology is persisted, and no slot was invented on the way", async () => {
    const rows = await query(
      "select role, content from messages where conversation_id = $1 order by created_at",
      [conversationId],
    );
    assert.equal(rows.length, 2, JSON.stringify(rows));
    assert.equal(rows[1].content, MODEL_FAILURE_REPLY);

    const [conversation] = await query("select slots, status from conversations where id = $1", [
      conversationId,
    ]);
    assert.equal(conversation.status, "active", "an outage must not close a conversation");
    for (const value of Object.values(conversation.slots as Record<string, unknown>)) {
      assert.equal(value, null, `a slot was filled with no model: ${JSON.stringify(conversation.slots)}`);
    }
  });

  await t.test("the conversation is left answerable, so the next sweep can retry", async () => {
    const [row] = await query("select processing_since from conversations where id = $1", [
      conversationId,
    ]);
    assert.equal(row.processing_since, null, "the claim was not released");
  });

  t.after(async () => {
    await query("delete from events where conversation_id = $1", [conversationId]);
    await query("delete from messages where conversation_id = $1", [conversationId]);
    await query("delete from conversations where id = $1", [conversationId]);
    await query("delete from leads where id = $1", [leadId]);
    await closePool();
  });
});
