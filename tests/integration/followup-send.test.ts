import test from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../../src/core/logging.ts";
import { closePool, getDb } from "../../src/db/client.ts";
import { sweepFollowups } from "../../src/jobs/followup.ts";
import { qualifiedLead, query } from "./support/meeting.ts";

/**
 * INTEGRATION=1, local e4b — spec 006 FR-014 to FR-016 end to end: a due
 * attempt on a demo-agency conversation goes through the real writer and the
 * real web channel, lands as an agent message marked as a follow-up, and
 * leaves a `followup.sent` event carrying the writer's trace. The sweep's clock
 * is pinned inside the window so the test does not depend on the hour it runs.
 */
const integration = process.env.INTEGRATION === "1";
const INSIDE = new Date("2030-01-07T15:00:00Z"); // Monday 12:00 in São Paulo

test("a due follow-up is written, sent and recorded", { skip: !integration }, async (t) => {
  const lead = await qualifiedLead();
  t.after(async () => {
    await lead.cleanup();
    await closePool();
  });
  // Stalled mid-script: urgency is the question left hanging.
  await query(
    `update conversations set slots = $2::jsonb, followup_state = 'pending' where id = $1`,
    [lead.conversationId, JSON.stringify({ priceMax: 700000, bedrooms: 2, neighborhoods: ["Moema"] })],
  );
  await query(
    `insert into followup_jobs (agency_id, conversation_id, attempt, scheduled_for)
     select agency_id, id, 1, $2 from conversations where id = $1`,
    [lead.conversationId, new Date(INSIDE.getTime() - 60_000)],
  );

  // Scoped to this conversation: the clock is years ahead, and every real
  // pending attempt in the demo agency would otherwise be due too.
  const outcomes = await sweepFollowups(
    { db: getDb(), now: INSIDE, log: createLogger("worker", { module: "test" }) },
    undefined,
    { conversationIds: [lead.conversationId] },
  );
  assert.deepEqual(outcomes.map((o) => o.outcome), ["sent"], JSON.stringify(outcomes));

  const [message] = await query(
    `select content, metadata from messages where conversation_id = $1 and role = 'agent' order by created_at desc limit 1`,
    [lead.conversationId],
  );
  console.log(`follow-up: ${message.content}`);
  assert.equal((message.metadata as Record<string, unknown>).isFollowUp, true);
  assert.match(message.content as string, /Moema/);
  assert.ok((message.content as string).trim().endsWith("?"));

  const [event] = await query(
    `select actor_type, trace_id, payload from events where conversation_id = $1 and type = 'followup.sent'`,
    [lead.conversationId],
  );
  assert.equal(event.actor_type, "worker");
  console.log(`trace: ${String(event.trace_id)}`);
  const [conversation] = await query(`select followup_attempts, followup_state from conversations where id = $1`, [
    lead.conversationId,
  ]);
  assert.equal(conversation.followup_attempts, 1);
  assert.equal(conversation.followup_state, "pending");
});
