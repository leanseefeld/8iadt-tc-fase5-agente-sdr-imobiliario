import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closePool, getPool } from "../../src/db/client.ts";
import { closeNotifier } from "../../src/core/notifier.ts";
import { recordLeadMessage } from "../../src/services/conversation.ts";

/**
 * POST /api/chat tells the widget whether a reply is on its way. A paused
 * conversation (a handoff, a broker in charge) stores the message and runs no
 * turn — and the widget's "typing…" over "blz, no aguardo" never ended (07/10).
 */
const integration = process.env.INTEGRATION === "1";
const base = process.env.TEST_APP_URL;
const sessionId = `test-post-${randomUUID()}`;

test("a message to a paused conversation is stored and promises no reply", {
  skip: !integration || base === undefined,
}, async (t) => {
  const pool = getPool();
  t.after(async () => {
    await pool.query(
      `delete from messages where conversation_id in
         (select c.id from conversations c join leads l on l.id = c.lead_id where l.external_id = $1)`,
      [sessionId],
    );
    await pool.query(`delete from events where lead_id in (select id from leads where external_id = $1)`, [sessionId]);
    await pool.query(`delete from conversations where lead_id in (select id from leads where external_id = $1)`, [sessionId]);
    await pool.query(`delete from leads where external_id = $1`, [sessionId]);
    await closeNotifier();
    await closePool();
  });

  const opened = await recordLeadMessage({
    agencySlug: "demo",
    externalId: sessionId,
    clientMessageId: randomUUID(),
    text: "oi",
    consent: true,
  });
  assert.ok("conversationId" in opened);
  // The handoff paused it; nobody has assumed it yet.
  await pool.query("update conversations set status = 'paused' where id = $1", [opened.conversationId]);

  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agencySlug: "demo", sessionId, clientMessageId: randomUUID(), text: "blz, no aguardo", consent: true }),
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.status, 202);
  const body = (await response.json()) as { conversationId?: string; turn?: boolean };
  assert.equal(body.conversationId, opened.conversationId);
  assert.equal(body.turn, false, "no reply is on its way");
});
