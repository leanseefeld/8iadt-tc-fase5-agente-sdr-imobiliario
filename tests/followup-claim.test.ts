import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { closePool, getDb } from "../src/db/client.ts";
import { agencies, conversations, events, followupJobs, leads } from "../src/db/schema.ts";
import { createLogger } from "../src/core/logging.ts";
import { sweepFollowups, type FollowupDeps } from "../src/jobs/followup.ts";

/**
 * Spec 006 T028, SC-005: two workers sweeping the same 100 due attempts at
 * once — every attempt sent exactly once, none twice, none lost. Postgres,
 * INTEGRATION=1, a throwaway agency, a stub writer and channel.
 */
const integration = process.env.INTEGRATION === "1";
const INSIDE = new Date("2030-01-07T15:00:00Z"); // Monday 12:00 in São Paulo
const ROWS = 100;

test("SC-005: two concurrent claimers over 100 due rows", { skip: !integration }, async (t) => {
  const db = getDb();
  const [agency] = await db
    .insert(agencies)
    .values({ name: "Teste claim", slug: `teste-claim-${randomUUID().slice(0, 8)}` })
    .returning({ id: agencies.id });
  const agencyId = agency.id;
  t.after(async () => {
    await db.delete(events).where(eq(events.agencyId, agencyId));
    await db.delete(followupJobs).where(eq(followupJobs.agencyId, agencyId));
    await db.delete(conversations).where(eq(conversations.agencyId, agencyId));
    await db.delete(leads).where(eq(leads.agencyId, agencyId));
    await db.delete(agencies).where(eq(agencies.id, agencyId));
    await closePool();
  });

  const leadRows = await db
    .insert(leads)
    .values(Array.from({ length: ROWS }, () => ({ agencyId, channel: "web" as const, externalId: randomUUID() })))
    .returning({ id: leads.id });
  const convRows = await db
    .insert(conversations)
    .values(leadRows.map((lead) => ({ agencyId, leadId: lead.id, channel: "web" as const, followupState: "pending" as const })))
    .returning({ id: conversations.id });
  await db
    .insert(followupJobs)
    .values(convRows.map((row) => ({ agencyId, conversationId: row.id, attempt: 1, scheduledFor: new Date(INSIDE.getTime() - 60_000) })));

  const sent: string[] = [];
  const deps: FollowupDeps = {
    write: async () => {
      // Long enough for the two claimers to interleave.
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { text: "Oi! Ainda procura? Qual faixa de preço você tem em mente?", opening: "model" };
    },
    send: async (message) => {
      sent.push(message.conversationId);
    },
  };
  const log = createLogger("worker", { module: "test/followup-claim" });

  async function worker(): Promise<number> {
    let processed = 0;
    for (;;) {
      const outcomes = await sweepFollowups({ db, now: INSIDE, log }, deps, { agencyId });
      if (outcomes.length === 0) return processed;
      processed += outcomes.length;
    }
  }

  const [a, b] = await Promise.all([worker(), worker()]);
  assert.equal(a + b, ROWS, `worker A ${a}, worker B ${b}`);
  assert.equal(sent.length, ROWS, "none lost");
  assert.equal(new Set(sent).size, ROWS, "none twice");
  assert.ok(a > 0 && b > 0, `both workers claimed (A ${a}, B ${b})`);

  const statuses = await db
    .select({ status: followupJobs.status, attempt: followupJobs.attempt })
    .from(followupJobs)
    .where(inArray(followupJobs.conversationId, convRows.map((row) => row.id)));
  assert.equal(statuses.filter((row) => row.status === "sent").length, ROWS);
  assert.equal(statuses.filter((row) => row.status === "pending" && row.attempt === 2).length, ROWS);
});
