import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { closePool, getDb } from "../src/db/client.ts";
import { agencies, appointments, conversations, events, followupJobs, leads, users } from "../src/db/schema.ts";
import {
  bookAppointment,
  cancelAppointment,
  computeOptions,
  computeRescheduleOptions,
  declineProposal,
  listUpcomingMeetings,
  proposeAppointment,
  rescheduleAppointment,
} from "../src/services/scheduling.ts";

/**
 * T010 — the scheduling service against the container's Postgres. Runs with
 * INTEGRATION=1, like every database-backed test here, on a throwaway agency so
 * the demo data is never touched. A fixed Monday in 2030 keeps every date
 * deterministic: 08:00 in São Paulo, so the first options are 10:00, 14:00 and
 * 16:30 the same day (two hours' notice, the default).
 */

const integration = process.env.INTEGRATION === "1";
const NOW = new Date("2030-01-07T11:00:00Z"); // Monday 08:00, America/Sao_Paulo
const WORK_WEEK = Object.fromEntries(
  ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => [
    day,
    { enabled: day !== "sat" && day !== "sun", start: "09:00", end: "18:00" },
  ]),
);

test("scheduling service", { skip: !integration }, async (t) => {
  const db = getDb();
  const [agency] = await db
    .insert(agencies)
    .values({ name: "Teste 006", slug: `teste-006-${randomUUID().slice(0, 8)}` })
    .returning({ id: agencies.id });
  const agencyId = agency.id;

  async function broker(name: string, specializations: string[]): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({
        agencyId,
        name,
        email: `${name}-${randomUUID().slice(0, 6)}@teste.local`,
        passwordHash: "x",
        role: "broker",
        specializations,
        availability: WORK_WEEK,
      })
      .returning({ id: users.id });
    return row.id;
  }

  async function conversation(assignedBrokerId?: string): Promise<{ leadId: string; conversationId: string }> {
    const [lead] = await db
      .insert(leads)
      .values({ agencyId, channel: "web", externalId: randomUUID(), ...(assignedBrokerId ? { assignedBrokerId } : {}) })
      .returning({ id: leads.id });
    const [conv] = await db
      .insert(conversations)
      .values({ agencyId, leadId: lead.id, channel: "web" })
      .returning({ id: conversations.id });
    return { leadId: lead.id, conversationId: conv.id };
  }

  const ana = await broker("ana", ["purchase", "rental"]);
  const bruno = await broker("bruno", ["purchase"]);
  const carla = await broker("carla", ["purchase"]);
  const ivo = await broker("ivo", ["investment"]);

  t.after(async () => {
    await db.delete(events).where(eq(events.agencyId, agencyId));
    await db.delete(appointments).where(eq(appointments.agencyId, agencyId));
    await db.delete(followupJobs).where(eq(followupJobs.agencyId, agencyId));
    await db.delete(conversations).where(eq(conversations.agencyId, agencyId));
    await db.delete(leads).where(eq(leads.agencyId, agencyId));
    await db.delete(users).where(eq(users.agencyId, agencyId));
    await db.delete(agencies).where(eq(agencies.id, agencyId));
    await closePool();
  });

  await t.test("computeOptions writes nothing and names no broker", async () => {
    const { leadId } = await conversation();
    const before = await db.select().from(appointments).where(eq(appointments.agencyId, agencyId));
    const computed = await computeOptions({ agencyId, leadId, intent: "purchase", now: NOW });
    const after = await db.select().from(appointments).where(eq(appointments.agencyId, agencyId));
    assert.equal(after.length, before.length);
    assert.ok(!("unavailable" in computed));
    assert.equal(computed.options.length, 3);
    assert.deepEqual(Object.keys(computed).sort(), ["brokerId", "options", "propertyId", "type"]);
    const [lead] = await db.select({ assigned: leads.assignedBrokerId }).from(leads).where(eq(leads.id, leadId));
    assert.equal(lead.assigned, null, "the assignment is recordProposal's to write");
  });

  await t.test("a re-proposal replaces the open one rather than accumulating", async () => {
    const ctx = await conversation();
    const first = await proposeAppointment({ agencyId, intent: "purchase", now: NOW, ...ctx });
    const second = await proposeAppointment({ agencyId, intent: "purchase", now: NOW, ...ctx, constraint: { period: "afternoon" } });
    assert.ok(first.ok && second.ok);
    const rows = await db
      .select({ id: appointments.id, status: appointments.status })
      .from(appointments)
      .where(eq(appointments.conversationId, ctx.conversationId));
    assert.deepEqual(
      Object.fromEntries(rows.map((row) => [row.id, row.status])),
      { [first.appointmentId]: "cancelled", [second.appointmentId]: "proposed" },
    );
    assert.ok(second.options.every((option) => option.scheduledAt.getUTCHours() - 3 >= 12), "afternoon only");
    const proposed = await db
      .select()
      .from(events)
      .where(and(eq(events.conversationId, ctx.conversationId), eq(events.type, "appointment.proposed")));
    assert.equal(proposed.length, 2);
  });

  await t.test("an investment lead always gets a call, with no property, from a specialist", async () => {
    const ctx = await conversation();
    const result = await proposeAppointment({ agencyId, intent: "investment", propertyId: randomUUID(), now: NOW, ...ctx });
    assert.ok(result.ok);
    assert.ok(result.options.every((option) => option.type === "call"));
    const [row] = await db.select().from(appointments).where(eq(appointments.id, result.appointmentId));
    assert.equal(row.type, "call");
    assert.equal(row.propertyId, null);
    assert.equal(row.brokerId, ivo);
  });

  await t.test("rotation among purchase specialists stays even", async () => {
    for (let i = 0; i < 6; i += 1) {
      await proposeAppointment({ agencyId, intent: "purchase", now: NOW, ...(await conversation()) });
    }
    const assigned = await db
      .select({ broker: leads.assignedBrokerId })
      .from(leads)
      .where(and(eq(leads.agencyId, agencyId), inArray(leads.assignedBrokerId, [ana, bruno, carla])));
    const counts = [ana, bruno, carla].map((id) => assigned.filter((row) => row.broker === id).length);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, JSON.stringify(counts));
    assert.ok(!assigned.some((row) => row.broker === ivo));
  });

  await t.test("a decline leaves the proposal cancelled, and a second decline finds nothing", async () => {
    const ctx = await conversation();
    const proposed = await proposeAppointment({ agencyId, intent: "purchase", now: NOW, ...ctx });
    assert.ok(proposed.ok);
    assert.equal(await declineProposal(ctx.conversationId), true);
    const [row] = await db.select({ status: appointments.status }).from(appointments).where(eq(appointments.id, proposed.appointmentId));
    assert.equal(row.status, "cancelled");
    assert.equal(await declineProposal(ctx.conversationId), false);
  });

  await t.test("booking by option confirms the row, schedules the lead and emits the event", async () => {
    const ctx = await conversation();
    const proposed = await proposeAppointment({ agencyId, intent: "purchase", now: NOW, ...ctx });
    assert.ok(proposed.ok);
    const booked = await bookAppointment({
      conversationId: ctx.conversationId,
      choice: { optionIndex: 2 },
      offered: proposed.options.map((option) => option.scheduledAt),
      now: NOW,
    });
    assert.ok(booked.ok);
    assert.equal(booked.appointmentId, proposed.appointmentId, "the proposal and its booking are the same row");
    assert.equal(booked.scheduledAt.toISOString(), proposed.options[1].scheduledAt.toISOString());
    const [lead] = await db.select({ status: leads.status }).from(leads).where(eq(leads.id, ctx.leadId));
    assert.equal(lead.status, "scheduled");
    const confirmed = await db
      .select()
      .from(events)
      .where(and(eq(events.conversationId, ctx.conversationId), eq(events.type, "appointment.confirmed")));
    assert.equal(confirmed.length, 1);
  });

  await t.test("two leads racing for the same hour: exactly one wins, the other hears collision", async () => {
    const first = await conversation(bruno);
    const second = await conversation(bruno);
    const a = await proposeAppointment({ agencyId, intent: "purchase", now: NOW, ...first });
    const b = await proposeAppointment({ agencyId, intent: "purchase", now: NOW, ...second });
    assert.ok(a.ok && b.ok);
    const hour = new Date("2030-01-09T13:00:00Z"); // Wednesday 10:00 local, free for Bruno
    const results = await Promise.all([
      bookAppointment({ conversationId: first.conversationId, choice: { scheduledAt: hour }, now: NOW }),
      bookAppointment({ conversationId: second.conversationId, choice: { scheduledAt: hour }, now: NOW }),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.deepEqual(results.find((result) => !result.ok), { ok: false, reason: "collision" });
  });

  await t.test("a time the rules reject fails even when the calendar is free, and touches nothing", async () => {
    const ctx = await conversation();
    const proposed = await proposeAppointment({ agencyId, intent: "purchase", now: NOW, ...ctx });
    assert.ok(proposed.ok);
    const saturday = new Date("2030-01-12T13:00:00Z"); // Saturday 10:00 local
    const tooSoon = new Date("2030-01-07T12:00:00Z"); // one hour from NOW
    assert.deepEqual(
      await bookAppointment({ conversationId: ctx.conversationId, choice: { scheduledAt: saturday }, now: NOW }),
      { ok: false, reason: "unavailable" },
    );
    assert.deepEqual(
      await bookAppointment({ conversationId: ctx.conversationId, choice: { scheduledAt: tooSoon }, now: NOW }),
      { ok: false, reason: "too_soon" },
    );
    assert.deepEqual(
      await bookAppointment({ conversationId: ctx.conversationId, choice: { optionIndex: 5 }, offered: [], now: NOW }),
      { ok: false, reason: "no_such_option" },
    );
    const [row] = await db.select({ status: appointments.status }).from(appointments).where(eq(appointments.id, proposed.appointmentId));
    assert.equal(row.status, "proposed", "a refused booking leaves the proposal open");
  });

  // Spec 009 — moving and cancelling what was booked.
  async function confirmedAt(at: Date, broker: string): Promise<{ id: string; leadId: string; conversationId: string }> {
    const ctx = await conversation(broker);
    const [row] = await db
      .insert(appointments)
      .values({ agencyId, leadId: ctx.leadId, conversationId: ctx.conversationId, brokerId: broker, scheduledAt: at, type: "call", status: "confirmed" })
      .returning({ id: appointments.id });
    return { id: row.id, ...ctx };
  }

  await t.test("009: a reschedule moves the same row, and its own slot never blocks it", async () => {
    const wed10 = new Date("2030-01-09T13:00:00Z"); // Wednesday 10:00 local
    const wed11 = new Date("2030-01-09T14:00:00Z"); // 11:00 — overlaps its own 10:00 hour
    const meeting = await confirmedAt(wed10, carla);
    const moved = await rescheduleAppointment({ appointmentId: meeting.id, choice: { scheduledAt: wed11 }, now: NOW });
    assert.ok(moved.ok, JSON.stringify(moved));
    const rows = await db.select().from(appointments).where(eq(appointments.leadId, meeting.leadId));
    assert.equal(rows.length, 1, "moved, not duplicated");
    assert.equal(rows[0].scheduledAt.toISOString(), wed11.toISOString());
    const [event] = await db
      .select()
      .from(events)
      .where(and(eq(events.conversationId, meeting.conversationId), eq(events.type, "appointment.rescheduled")));
    assert.ok(event !== undefined);
  });

  await t.test("009: a reschedule is judged like a booking — notice, the broker's week, others' meetings", async () => {
    const thu10 = new Date("2030-01-10T13:00:00Z");
    const other = await confirmedAt(new Date("2030-01-10T17:00:00Z"), carla); // Thursday 14:00, someone else
    const meeting = await confirmedAt(thu10, carla);
    const at = (scheduledAt: Date) => rescheduleAppointment({ appointmentId: meeting.id, choice: { scheduledAt }, now: NOW });
    assert.deepEqual(await at(new Date("2030-01-07T12:00:00Z")), { ok: false, reason: "too_soon" });
    assert.deepEqual(await at(new Date("2030-01-12T13:00:00Z")), { ok: false, reason: "unavailable" }, "Saturday");
    assert.deepEqual(await at(new Date("2030-01-10T17:00:00Z")), { ok: false, reason: "collision" });
    void other;
    const options = await computeRescheduleOptions(meeting.id, {}, NOW);
    assert.ok(options.ok && options.options.every((option) => option.getTime() !== new Date("2030-01-10T17:00:00Z").getTime()));
  });

  await t.test("009: cancel is scoped to the lead, and leaves the list of what's still to come", async () => {
    const meeting = await confirmedAt(new Date("2030-01-11T13:00:00Z"), carla);
    const stranger = await conversation();
    assert.equal(await cancelAppointment(meeting.id, stranger.leadId), false, "another lead's id cancels nothing");
    assert.equal((await listUpcomingMeetings(meeting.leadId, NOW)).length, 1);
    assert.equal(await cancelAppointment(meeting.id, meeting.leadId), true);
    assert.equal((await listUpcomingMeetings(meeting.leadId, NOW)).length, 0);
    assert.equal(await cancelAppointment(meeting.id, meeting.leadId), false, "twice is nothing");
  });

  await t.test("with no open proposal, booking has nothing to book", async () => {
    const ctx = await conversation();
    assert.deepEqual(
      await bookAppointment({ conversationId: ctx.conversationId, choice: { optionIndex: 1 }, offered: [NOW], now: NOW }),
      { ok: false, reason: "no_proposal" },
    );
  });
});
