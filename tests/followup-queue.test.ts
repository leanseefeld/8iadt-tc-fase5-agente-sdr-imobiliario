import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { closePool, getDb } from "../src/db/client.ts";
import { agencies, appointments, conversations, events, followupJobs, leads, messages, users } from "../src/db/schema.ts";
import { createLogger } from "../src/core/logging.ts";
import type { OutboundMessage } from "../src/channels/types.ts";
import { sweepFollowups, type FollowupDeps } from "../src/jobs/followup.ts";
import { recordLeadMessage } from "../src/services/conversation.ts";
import { scheduleFollowup } from "../src/services/followup.ts";
import { cancelQueued, listQueue, sendNow, sendOwnFollowup } from "../src/services/followup-queue.ts";
import { getAgencySettings, updateAgencySettings } from "../src/services/agency-settings.ts";
import { transitionAppointment } from "../src/services/scheduling.ts";

/**
 * Spec 017's examples, against Postgres (INTEGRATION=1), a throwaway agency, a
 * stub writer and a recording channel: everything under test is code.
 */
const integration = process.env.INTEGRATION === "1";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SATURDAY_NIGHT = new Date("2030-01-06T01:10:00Z"); // Saturday 22:10 in São Paulo
const SUNDAY_MORNING = new Date("2030-01-06T13:00:00Z"); // Sunday 10:00
const MONDAY_NOON = new Date("2030-01-07T15:00:00Z"); // Monday 12:00

test("spec 017: the queue, the settings and the reminder", { skip: !integration }, async (t) => {
  const db = getDb();
  const slug = `teste-017-${randomUUID().slice(0, 8)}`;
  const [agency] = await db.insert(agencies).values({ name: "Teste 017", slug }).returning({ id: agencies.id });
  const agencyId = agency.id;
  const scope = { agencyId, defaultOwnLeadsOnly: false };
  const [broker] = await db
    .insert(users)
    .values({ agencyId, name: "Beatriz Teste", email: `bia-${randomUUID().slice(0, 6)}@teste.local`, passwordHash: "x", role: "broker" })
    .returning({ id: users.id });
  const [manager] = await db
    .insert(users)
    .values({ agencyId, name: "Gil Teste", email: `gil-${randomUUID().slice(0, 6)}@teste.local`, passwordHash: "x", role: "salesManager" })
    .returning({ id: users.id });
  const log = createLogger("worker", { module: "test/017" });

  const sent: OutboundMessage[] = [];
  const deps: FollowupDeps = {
    write: async () => ({ text: "Oi! Ainda procurando apartamento?", opening: "model" }),
    send: async (message) => {
      sent.push(message);
    },
  };
  const sweep = (now: Date) => sweepFollowups({ db, now, log }, deps, { agencyId });
  const sentTo = (conversationId: string) => sent.filter((message) => message.conversationId === conversationId);

  async function lead(options: { due?: Date; name?: string } = {}) {
    const externalId = randomUUID();
    const [row] = await db
      .insert(leads)
      .values({
        agencyId,
        channel: "web",
        externalId,
        intent: "purchase",
        name: options.name ?? "Ana Ribeiro",
        assignedBrokerId: broker.id,
        consentAt: new Date("2029-12-01T00:00:00Z"),
      })
      .returning({ id: leads.id });
    const [conversation] = await db
      .insert(conversations)
      .values({ agencyId, leadId: row.id, channel: "web", followupState: "pending", slots: {} })
      .returning({ id: conversations.id });
    const [job] = await db
      .insert(followupJobs)
      .values({ agencyId, conversationId: conversation.id, attempt: 1, scheduledFor: options.due ?? SATURDAY_NIGHT })
      .returning({ id: followupJobs.id });
    return { leadId: row.id, conversationId: conversation.id, jobId: job.id, externalId };
  }

  /** A confirmed meeting, through the one transition function — so its reminder is queued as booking queues it. */
  async function meeting(owner: { leadId: string; conversationId: string }, at: Date, type: "viewing" | "call" = "viewing") {
    const [row] = await db
      .insert(appointments)
      .values({ agencyId, leadId: owner.leadId, conversationId: owner.conversationId, brokerId: broker.id, type, status: "proposed", scheduledAt: at })
      .returning({ id: appointments.id });
    assert.ok(await transitionAppointment(db, row.id, "proposed", "confirmed"));
    return row.id;
  }

  const jobOf = async (id: string) => (await db.select().from(followupJobs).where(eq(followupJobs.id, id)))[0];
  const reminderOf = async (appointmentId: string) =>
    db.select().from(followupJobs).where(and(eq(followupJobs.appointmentId, appointmentId), eq(followupJobs.kind, "reminder")));
  const pendingReminder = async (appointmentId: string) => (await reminderOf(appointmentId)).filter((job) => job.status === "pending");

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

  await t.test("example 1: window closed, the queue says when; Enviar agora sends past it", async () => {
    const marcos = await lead({ name: "Marcos Lima" });
    const groups = await listQueue(scope, {}, SATURDAY_NIGHT);
    const row = groups.flatMap((group) => group.rows).find((r) => r.jobId === marcos.jobId);
    assert.ok(row);
    assert.equal(row.goesAt.toISOString(), "2030-01-06T12:00:00.000Z", "Sunday 09:00, the window's next opening");

    assert.deepEqual((await sweep(SATURDAY_NIGHT)).map((o) => o.outcome), ["rescheduled"]);
    assert.deepEqual(await sendNow(scope, broker.id, marcos.jobId, SATURDAY_NIGHT), { ok: true });
    assert.equal((await jobOf(marcos.jobId)).bypassWindow, true);
    const outcomes = await sweep(new Date(SATURDAY_NIGHT.getTime() + MINUTE));
    assert.deepEqual(outcomes.map((o) => o.outcome), ["sent"]);
    assert.equal(sentTo(marcos.conversationId).length, 1);
    const next = (await db.select().from(followupJobs).where(eq(followupJobs.conversationId, marcos.conversationId))).filter(
      (job) => job.status === "pending",
    );
    assert.equal(next.length, 1);
    assert.equal(next[0].attempt, 2);
    assert.equal(next[0].bypassWindow, false, "the bypass was for that send only");
  });

  await t.test("example 2: the switch off refuses Enviar agora, in words", async () => {
    await db.update(agencies).set({ followupEnabled: false }).where(eq(agencies.id, agencyId));
    const marcos = await lead();
    const result = await sendNow(scope, broker.id, marcos.jobId, SATURDAY_NIGHT);
    assert.deepEqual(result, { ok: false, message: "O follow-up automático está desligado nesta imobiliária." });
    await db.update(agencies).set({ followupEnabled: true }).where(eq(agencies.id, agencyId));
    await db.update(followupJobs).set({ status: "cancelled" }).where(eq(followupJobs.id, marcos.jobId));
  });

  await t.test("example 3: Eu escrevo goes out as the broker's message and counts as the attempt", async () => {
    const marcos = await lead();
    const text = "Oi Marcos, separei mais duas opções na Trindade, quer ver?";
    assert.deepEqual(await sendOwnFollowup(scope, broker.id, marcos.jobId, text, SATURDAY_NIGHT), { ok: true });
    const [message] = await db.select().from(messages).where(eq(messages.conversationId, marcos.conversationId));
    assert.equal(message.role, "broker");
    assert.equal(message.content, text);
    assert.equal(message.metadata.userId, broker.id);
    assert.equal(message.metadata.isFollowUp, true);
    assert.equal((await jobOf(marcos.jobId)).status, "sent");
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, marcos.conversationId));
    assert.equal(conversation.followupAttempts, 1);
    assert.equal(conversation.status, "active", "the conversation stays with Sofia");
    const event = (await db.select().from(events).where(eq(events.conversationId, marcos.conversationId))).find(
      (row) => row.type === "followup.sent",
    );
    assert.equal(event?.actorUserId, broker.id);
  });

  await t.test("example 4: Cancelar stops the chain until the lead writes again", async () => {
    const marcos = await lead();
    assert.deepEqual(await cancelQueued(scope, broker.id, marcos.jobId, SATURDAY_NIGHT), { ok: true });
    assert.equal((await jobOf(marcos.jobId)).status, "cancelled");
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, marcos.conversationId));
    assert.equal(conversation.followupState, "none");
    assert.deepEqual(await sendNow(scope, broker.id, marcos.jobId), { ok: false, message: "Esta mensagem já saiu ou foi cancelada." });

    // The lead writes; the agent's next turn queues a fresh one.
    await recordLeadMessage({ agencySlug: slug, externalId: marcos.externalId, clientMessageId: randomUUID(), text: "oi", consent: true });
    assert.ok(await db.transaction((tx) => scheduleFollowup(tx, marcos.conversationId, MONDAY_NOON)));
    const pending = (await db.select().from(followupJobs).where(eq(followupJobs.conversationId, marcos.conversationId))).filter(
      (job) => job.status === "pending",
    );
    assert.equal(pending.length, 1);
  });

  await t.test("example 5: Sunday off moves a Sunday follow-up to Monday 09:00, with no restart", async () => {
    const before = await getAgencySettings(agencyId);
    const refused = await updateAgencySettings(scope, "broker", broker.id, { ...before, windowDays: ["mon"] });
    assert.equal(refused.ok, false, "a broker cannot change the settings");
    const none = await updateAgencySettings(scope, "salesManager", manager.id, { ...before, windowDays: [] });
    assert.deepEqual(none, { ok: false, field: "windowDays", message: "Deixe pelo menos um dia da semana aberto." });

    const saved = await updateAgencySettings(scope, "salesManager", manager.id, {
      ...before,
      windowDays: ["mon", "tue", "wed", "thu", "fri", "sat"],
    });
    assert.deepEqual(saved, { ok: true });
    const sunday = await lead({ due: SUNDAY_MORNING });
    const outcome = (await sweep(SUNDAY_MORNING)).find((o) => o.jobId === sunday.jobId);
    assert.equal(outcome?.outcome, "rescheduled");
    assert.equal((await jobOf(sunday.jobId)).scheduledFor.toISOString(), "2030-01-07T12:00:00.000Z");
    await updateAgencySettings(scope, "salesManager", manager.id, before);
  });

  await t.test("examples 6, 10: confirming queues the reminder 2 h ahead; rescheduling moves it", async () => {
    const ana = await lead();
    const at = new Date(Date.now() + 26 * HOUR);
    const appointmentId = await meeting(ana, at);
    const [reminder] = await pendingReminder(appointmentId);
    assert.equal(reminder.scheduledFor.getTime(), at.getTime() - 2 * HOUR);
    assert.equal(reminder.attempt, 0);

    const later = new Date(at.getTime() + 24 * HOUR);
    assert.ok(await transitionAppointment(db, appointmentId, "confirmed", "confirmed", { scheduledAt: later }));
    const moved = await pendingReminder(appointmentId);
    assert.equal(moved.length, 1, "moved, not duplicated");
    assert.equal(moved[0].id, reminder.id);
    assert.equal(moved[0].scheduledFor.getTime(), later.getTime() - 2 * HOUR);
  });

  await t.test("example 7 (code half): the lead writing cancels follow-ups, never the reminder", async () => {
    const ana = await lead();
    const appointmentId = await meeting(ana, new Date(Date.now() + 26 * HOUR));
    await recordLeadMessage({ agencySlug: slug, externalId: ana.externalId, clientMessageId: randomUUID(), text: "obrigada!", consent: true });
    assert.equal((await jobOf(ana.jobId)).status, "cancelled", "the follow-up went");
    assert.equal((await pendingReminder(appointmentId)).length, 1, "the reminder stayed");
  });

  await t.test("example 6: at its time the reminder is written, informational, and names no broker", async () => {
    const ana = await lead();
    const at = new Date(Date.now() + 26 * HOUR);
    const appointmentId = await meeting(ana, at);
    const [reminder] = await pendingReminder(appointmentId);
    const outcome = (await sweep(reminder.scheduledFor)).find((o) => o.jobId === reminder.id);
    assert.equal(outcome?.outcome, "reminded");
    const [message] = sentTo(ana.conversationId);
    assert.equal(message.reminderFor, appointmentId);
    assert.match(message.text, /^Oi, Ana! Passando pra lembrar: sua visita é hoje às \d{1,2}h(\d{2})?, com alguém da nossa equipe\. Pode avisar por aqui mesmo se não puder mais ou precisar remarcar\.$/);
    assert.ok(!message.text.includes("Beatriz"), "FR-005e: no broker's name");
    assert.ok(!message.text.includes("?"), "informational: it asks nothing");
    assert.equal((await jobOf(reminder.id)).status, "sent");
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, ana.conversationId));
    assert.equal(conversation.followupAttempts, 0, "a reminder is not an attempt");
  });

  await t.test("examples 8, 9: cancelled, done, or booked inside the lead time — no reminder", async () => {
    const ana = await lead();
    const cancelled = await meeting(ana, new Date(Date.now() + 26 * HOUR));
    assert.ok(await transitionAppointment(db, cancelled, "confirmed", "cancelled"));
    assert.equal((await pendingReminder(cancelled)).length, 0);

    const done = await meeting(ana, new Date(Date.now() + 30 * HOUR));
    assert.ok(await transitionAppointment(db, done, "confirmed", "done"));
    assert.equal((await pendingReminder(done)).length, 0);

    const soon = await meeting(ana, new Date(Date.now() + 90 * MINUTE));
    assert.equal((await reminderOf(soon)).length, 0, "booked an hour and a half ahead: the lead just confirmed");
  });

  await t.test("example 11: a held conversation gets Sofia announcing herself", async () => {
    const ana = await lead();
    await db.update(conversations).set({ status: "paused", heldByUserId: broker.id }).where(eq(conversations.id, ana.conversationId));
    const appointmentId = await meeting(ana, new Date(Date.now() + 26 * HOUR), "call");
    const [reminder] = await pendingReminder(appointmentId);
    await sweep(reminder.scheduledFor);
    const [message] = sentTo(ana.conversationId);
    assert.match(message.text, /^Sofia aqui, interrompendo só pra lembrar: sua conversa por telefone é hoje às /);
  });

  await t.test("examples 12, 13: reminders off, or the lead opted out — skipped, with the reason", async () => {
    const off = await lead();
    const offMeeting = await meeting(off, new Date(Date.now() + 26 * HOUR));
    await db.update(agencies).set({ remindersEnabled: false }).where(eq(agencies.id, agencyId));
    const [offReminder] = await pendingReminder(offMeeting);
    const offOutcome = (await sweep(offReminder.scheduledFor)).find((o) => o.jobId === offReminder.id);
    assert.deepEqual(offOutcome, { jobId: offReminder.id, outcome: "cancelled", reason: "switch_off" });
    await db.update(agencies).set({ remindersEnabled: true }).where(eq(agencies.id, agencyId));

    const optedOut = await lead();
    const optedMeeting = await meeting(optedOut, new Date(Date.now() + 26 * HOUR));
    await db.update(leads).set({ doNotContact: true }).where(eq(leads.id, optedOut.leadId));
    const [optedReminder] = await pendingReminder(optedMeeting);
    assert.equal(
      (await sendNow(scope, broker.id, optedReminder.id)).ok,
      false,
      "Enviar agora refuses an opted-out lead too",
    );
    await sweep(optedReminder.scheduledFor);
    assert.equal(sentTo(optedOut.conversationId).length, 0);
    const skipped = (await db.select().from(events).where(eq(events.conversationId, optedOut.conversationId))).find(
      (event) => event.type === "reminder.skipped",
    );
    assert.equal(skipped?.payload.reason, "opted_out");
  });

  await t.test("a new lead time re-times pending reminders", async () => {
    const ana = await lead();
    const at = new Date(Date.now() + 26 * HOUR);
    const appointmentId = await meeting(ana, at);
    const before = await getAgencySettings(agencyId);
    assert.deepEqual(await updateAgencySettings(scope, "salesManager", manager.id, { ...before, reminderLeadMinutes: 240 }), { ok: true });
    const [reminder] = await pendingReminder(appointmentId);
    assert.equal(reminder.scheduledFor.getTime(), at.getTime() - 4 * HOUR);
    await updateAgencySettings(scope, "salesManager", manager.id, before);
  });
});
