import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { closePool, getDb } from "../src/db/client.ts";
import { agencies, appointments, conversations, events, followupJobs, leads, messages, users } from "../src/db/schema.ts";
import { getConfig } from "../src/core/config.ts";
import { createLogger } from "../src/core/logging.ts";
import { sweepFollowups, type FollowupDeps } from "../src/jobs/followup.ts";
import { recordLeadMessage } from "../src/services/conversation.ts";
import { scheduleFollowup } from "../src/services/followup.ts";

/**
 * Spec 006 T029/T031b — what may be sent, and what happens to what may not
 * (SC-007, SC-008, SC-014, FR-013a). Postgres, INTEGRATION=1, a throwaway
 * agency, and a stub writer and channel: the rules under test are all code.
 */
const integration = process.env.INTEGRATION === "1";
const INSIDE = new Date("2030-01-07T15:00:00Z"); // Monday 12:00 in São Paulo
const OUTSIDE = new Date("2030-01-07T06:00:00Z"); // Monday 03:00
const MINUTE = 60_000;

test("follow-up eligibility", { skip: !integration }, async (t) => {
  const db = getDb();
  const slug = `teste-fu-${randomUUID().slice(0, 8)}`;
  const [agency] = await db.insert(agencies).values({ name: "Teste follow-up", slug }).returning({ id: agencies.id });
  const agencyId = agency.id;
  const [broker] = await db
    .insert(users)
    .values({ agencyId, name: "Ana Teste", email: `ana-${randomUUID().slice(0, 6)}@teste.local`, passwordHash: "x", role: "broker" })
    .returning({ id: users.id });
  const log = createLogger("worker", { module: "test/followup" });
  const config = getConfig();

  const sent: string[] = [];
  const deps: FollowupDeps = {
    write: async () => ({ text: "Oi! Passando para retomar a busca. Quantos quartos você precisa?", opening: "model" }),
    send: async (message) => {
      sent.push(message.conversationId);
    },
  };
  const sweep = (now: Date) => sweepFollowups({ db, now, log }, deps, { agencyId });

  async function stalled(options: { attempts?: number; due?: Date } = {}) {
    const externalId = randomUUID();
    const [lead] = await db
      .insert(leads)
      .values({ agencyId, channel: "web", externalId, intent: "purchase", consentAt: new Date("2030-01-01T00:00:00Z") })
      .returning({ id: leads.id });
    const [conversation] = await db
      .insert(conversations)
      .values({
        agencyId,
        leadId: lead.id,
        channel: "web",
        followupState: "pending",
        followupAttempts: options.attempts ?? 0,
        slots: { priceMax: 700000 },
      })
      .returning({ id: conversations.id });
    const [job] = await db
      .insert(followupJobs)
      .values({
        agencyId,
        conversationId: conversation.id,
        attempt: (options.attempts ?? 0) + 1,
        scheduledFor: options.due ?? new Date(INSIDE.getTime() - MINUTE),
      })
      .returning({ id: followupJobs.id });
    return { leadId: lead.id, conversationId: conversation.id, jobId: job.id, externalId };
  }

  const jobOf = async (id: string) => (await db.select().from(followupJobs).where(eq(followupJobs.id, id)))[0];
  const conversationOf = async (id: string) => (await db.select().from(conversations).where(eq(conversations.id, id)))[0];

  t.after(async () => {
    const convs = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.agencyId, agencyId));
    const ids = convs.map((row) => row.id);
    await db.delete(events).where(eq(events.agencyId, agencyId));
    await db.delete(followupJobs).where(eq(followupJobs.agencyId, agencyId));
    await db.delete(appointments).where(eq(appointments.agencyId, agencyId));
    if (ids.length > 0) await db.delete(messages).where(inArray(messages.conversationId, ids));
    await db.delete(conversations).where(eq(conversations.agencyId, agencyId));
    await db.delete(leads).where(eq(leads.agencyId, agencyId));
    await db.delete(users).where(eq(users.agencyId, agencyId));
    await db.delete(agencies).where(eq(agencies.id, agencyId));
    await closePool();
  });

  await t.test("due inside the window: sent, counted, and the next attempt backed off", async () => {
    const lead = await stalled();
    const outcomes = await sweep(INSIDE);
    assert.deepEqual(outcomes.map((o) => o.outcome), ["sent"]);
    assert.equal((await jobOf(lead.jobId)).status, "sent");
    const conversation = await conversationOf(lead.conversationId);
    assert.equal(conversation.followupAttempts, 1);
    assert.equal(conversation.followupState, "pending");
    const [next] = await db
      .select()
      .from(followupJobs)
      .where(eq(followupJobs.conversationId, lead.conversationId))
      .then((rows) => rows.filter((row) => row.status === "pending"));
    assert.equal(next.attempt, 2);
    const wait = (next.scheduledFor.getTime() - INSIDE.getTime()) / MINUTE;
    const expected = config.FOLLOWUP_FIRST_DELAY_MINUTES * config.FOLLOWUP_BACKOFF_FACTOR;
    assert.ok(Math.abs(wait - expected) < 1, `next attempt in ${wait} min, expected ${expected}`);
    const [event] = await db.select().from(events).where(eq(events.conversationId, lead.conversationId));
    assert.equal(event.type, "followup.sent");
    assert.equal(event.actorType, "worker");
  });

  await t.test("SC-007: due outside the window moves to the next opening, attempt unchanged", async () => {
    const lead = await stalled({ due: new Date(OUTSIDE.getTime() - MINUTE) });
    const outcomes = await sweep(OUTSIDE);
    assert.deepEqual(outcomes.map((o) => o.outcome), ["rescheduled"]);
    const job = await jobOf(lead.jobId);
    assert.equal(job.status, "pending");
    assert.equal(job.attempt, 1);
    assert.equal(job.scheduledFor.toISOString(), "2030-01-07T12:00:00.000Z");
    assert.equal((await conversationOf(lead.conversationId)).followupAttempts, 0);
    assert.ok(!sent.includes(lead.conversationId));
  });

  await t.test("opted out, paused, or booked: cancelled, nothing sent, and no pending state left (FR-013a)", async () => {
    const optedOut = await stalled();
    await db.update(leads).set({ doNotContact: true }).where(eq(leads.id, optedOut.leadId));
    const paused = await stalled();
    await db.update(conversations).set({ status: "paused" }).where(eq(conversations.id, paused.conversationId));
    const booked = await stalled();
    await db.insert(appointments).values({
      agencyId,
      leadId: booked.leadId,
      conversationId: booked.conversationId,
      brokerId: broker.id,
      type: "call",
      status: "confirmed",
      scheduledAt: new Date(INSIDE.getTime() + 24 * 60 * MINUTE),
    });

    // The attempt the window case moved to 09:00 is due now too, and sends; only these three are under test.
    const mine = new Set([optedOut.jobId, paused.jobId, booked.jobId]);
    const outcomes = (await sweep(INSIDE)).filter((o) => mine.has(o.jobId));
    assert.deepEqual(
      Object.fromEntries(outcomes.map((o) => [o.jobId, o.outcome === "cancelled" ? o.reason : o.outcome])),
      { [optedOut.jobId]: "opted_out", [paused.jobId]: "not_active", [booked.jobId]: "booked" },
    );
    for (const lead of [optedOut, paused, booked]) {
      assert.equal((await jobOf(lead.jobId)).status, "cancelled");
      assert.equal((await conversationOf(lead.conversationId)).followupState, "none");
      assert.ok(!sent.includes(lead.conversationId));
    }
  });

  await t.test("SC-014: with the switch off a due attempt is cancelled; back on, the next one sends", async () => {
    await db.update(agencies).set({ followupEnabled: false }).where(eq(agencies.id, agencyId));
    const lead = await stalled();
    assert.deepEqual((await sweep(INSIDE)).map((o) => (o.outcome === "cancelled" ? o.reason : o.outcome)), ["switch_off"]);
    assert.equal((await conversationOf(lead.conversationId)).followupState, "none");

    await db.update(agencies).set({ followupEnabled: true }).where(eq(agencies.id, agencyId));
    // Scheduling never read the switch; a new turn schedules as usual.
    await db.transaction((tx) => scheduleFollowup(tx, lead.conversationId, new Date(INSIDE.getTime() - 600 * MINUTE)));
    assert.deepEqual((await sweep(INSIDE)).map((o) => o.outcome), ["sent"]);
    assert.ok(sent.includes(lead.conversationId));
  });

  await t.test("the last attempt leaves the conversation exhausted, with nothing more queued", async () => {
    const lead = await stalled({ attempts: config.FOLLOWUP_MAX_ATTEMPTS - 1 });
    assert.deepEqual((await sweep(INSIDE)).map((o) => o.outcome), ["sent"]);
    const conversation = await conversationOf(lead.conversationId);
    assert.equal(conversation.followupState, "exhausted");
    const pending = (await db.select().from(followupJobs).where(eq(followupJobs.conversationId, lead.conversationId))).filter(
      (row) => row.status === "pending",
    );
    assert.equal(pending.length, 0);
  });

  await t.test("SC-008: a reply after a follow-up is recovered exactly once and clears the state", async () => {
    const lead = await stalled();
    await sweep(INSIDE);
    for (const text of ["oi, voltei", "ainda procuro sim"]) {
      const inbound = await recordLeadMessage({
        agencySlug: slug,
        externalId: lead.externalId,
        clientMessageId: randomUUID(),
        text,
        consent: true,
      });
      assert.equal(inbound.status, "stored");
    }
    const recovered = (await db.select().from(events).where(eq(events.conversationId, lead.conversationId))).filter(
      (event) => event.type === "followup.recovered",
    );
    assert.equal(recovered.length, 1);
    const conversation = await conversationOf(lead.conversationId);
    assert.equal(conversation.followupState, "none");
    assert.equal(conversation.followupAttempts, 0);
    const pending = (await db.select().from(followupJobs).where(eq(followupJobs.conversationId, lead.conversationId))).filter(
      (row) => row.status === "pending",
    );
    assert.equal(pending.length, 0);
  });

  await t.test("FR-009: scheduling is one pending attempt per conversation, moved rather than added", async () => {
    const lead = await stalled();
    const at = (minutes: number) => new Date(INSIDE.getTime() + minutes * MINUTE);
    assert.equal(await db.transaction((tx) => scheduleFollowup(tx, lead.conversationId, at(0))), true);
    assert.equal(await db.transaction((tx) => scheduleFollowup(tx, lead.conversationId, at(10))), true);
    const pending = (await db.select().from(followupJobs).where(eq(followupJobs.conversationId, lead.conversationId))).filter(
      (row) => row.status === "pending",
    );
    assert.equal(pending.length, 1);
    assert.equal(pending[0].scheduledFor.getTime(), at(10 + config.FOLLOWUP_FIRST_DELAY_MINUTES).getTime());

    await db.update(conversations).set({ status: "paused" }).where(eq(conversations.id, lead.conversationId));
    const other = await stalled();
    await db.update(conversations).set({ status: "paused" }).where(eq(conversations.id, other.conversationId));
    await db.delete(followupJobs).where(eq(followupJobs.id, other.jobId));
    assert.equal(await db.transaction((tx) => scheduleFollowup(tx, other.conversationId, at(0))), false, "paused: nothing");
  });
});
