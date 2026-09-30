import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { closePool, getDb } from "../src/db/client.ts";
import { agencies, appointments, conversations, events, leads, users } from "../src/db/schema.ts";
import { listAppointments, markAppointmentStatus } from "../src/services/scheduling.ts";
import { listLeads } from "../src/services/leads.ts";

/**
 * Spec 006 T036/T036a — the agenda's scope and order, and *Visita marcada*
 * derived from a confirmed future meeting (FR-007, FR-008, FR-008b). Postgres,
 * INTEGRATION=1, a throwaway agency.
 */
const integration = process.env.INTEGRATION === "1";
const NOW = new Date("2030-01-07T11:00:00Z"); // Monday 08:00 in São Paulo
const RANGE = { from: new Date("2030-01-07T03:00:00Z"), to: new Date("2030-01-21T03:00:00Z") };

test("the agenda", { skip: !integration }, async (t) => {
  const db = getDb();
  const [agency] = await db
    .insert(agencies)
    .values({ name: "Teste agenda", slug: `teste-agenda-${randomUUID().slice(0, 8)}` })
    .returning({ id: agencies.id });
  const agencyId = agency.id;
  const user = async (name: string, role: "broker" | "salesManager") =>
    (
      await db
        .insert(users)
        .values({ agencyId, name, email: `${name}-${randomUUID().slice(0, 6)}@teste.local`, passwordHash: "x", role })
        .returning({ id: users.id })
    )[0].id;
  const ana = await user("Ana", "broker");
  const bruno = await user("Bruno", "broker");
  const carla = await user("Carla", "salesManager");

  async function meeting(broker: string, at: Date, status: "proposed" | "confirmed", name: string) {
    const [lead] = await db
      .insert(leads)
      .values({ agencyId, channel: "web", externalId: randomUUID(), name, status: "scheduled", assignedBrokerId: broker })
      .returning({ id: leads.id });
    const [conv] = await db.insert(conversations).values({ agencyId, leadId: lead.id, channel: "web" }).returning({ id: conversations.id });
    const [row] = await db
      .insert(appointments)
      .values({ agencyId, leadId: lead.id, conversationId: conv.id, brokerId: broker, scheduledAt: at, type: "call", status })
      .returning({ id: appointments.id });
    return { leadId: lead.id, appointmentId: row.id };
  }

  t.after(async () => {
    await db.delete(events).where(eq(events.agencyId, agencyId));
    await db.delete(appointments).where(eq(appointments.agencyId, agencyId));
    await db.delete(conversations).where(eq(conversations.agencyId, agencyId));
    await db.delete(leads).where(eq(leads.agencyId, agencyId));
    await db.delete(users).where(eq(users.agencyId, agencyId));
    await db.delete(agencies).where(eq(agencies.id, agencyId));
    await closePool();
  });

  const late = await meeting(ana, new Date("2030-01-07T18:00:00Z"), "confirmed", "Tarde"); // today 15h
  await meeting(ana, new Date("2030-01-07T13:00:00Z"), "confirmed", "Manhã"); // today 10h
  await meeting(ana, new Date("2030-01-08T13:30:00Z"), "confirmed", "Amanhã"); // tomorrow 10h30
  await meeting(ana, new Date("2030-01-10T13:00:00Z"), "proposed", "Proposta"); // an offer, not a meeting
  await meeting(bruno, new Date("2030-01-07T14:00:00Z"), "confirmed", "Do Bruno");

  await t.test("a broker sees their own meetings by day, ascending, and never a proposal", async () => {
    const groups = await listAppointments({ agencyId, userId: ana, role: "broker" }, RANGE, NOW);
    assert.deepEqual(
      groups.map((group) => [group.label, group.rows.map((row) => `${row.time} ${row.leadName}`)]),
      [
        ["Hoje", ["10h Manhã", "15h Tarde"]],
        ["Amanhã", ["10h30 Amanhã"]],
      ],
    );
  });

  await t.test("a manager sees the agency's", async () => {
    const groups = await listAppointments({ agencyId, userId: carla, role: "salesManager" }, RANGE, NOW);
    assert.deepEqual(groups[0].rows.map((row) => row.leadName), ["Manhã", "Do Bruno", "Tarde"]);
  });

  await t.test("a broker cannot act on a colleague's meeting; marking done moves the lead to visited", async () => {
    const refused = await markAppointmentStatus({ agencyId, userId: bruno, role: "broker" }, late.appointmentId, "done");
    assert.equal(refused.ok, false);
    const done = await markAppointmentStatus({ agencyId, userId: ana, role: "broker" }, late.appointmentId, "done");
    assert.deepEqual(done, { ok: true });
    const [lead] = await db.select({ status: leads.status }).from(leads).where(eq(leads.id, late.leadId));
    assert.equal(lead.status, "visited");
    const [event] = await db
      .select()
      .from(events)
      .where(and(eq(events.leadId, late.leadId), eq(events.type, "appointment.done")));
    assert.equal(event.actorType, "user");
    assert.equal(event.actorUserId, ana);
    const again = await markAppointmentStatus({ agencyId, userId: ana, role: "broker" }, late.appointmentId, "cancelled");
    assert.equal(again.ok, false, "a finished meeting cannot be cancelled");
  });

  await t.test("FR-008b: Visita marcada is a confirmed meeting still to come, not the stage", async () => {
    // Relative to the real clock: the filter reads `now()` in SQL.
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60_000);
    const booked = await meeting(ana, soon, "confirmed", "Com visita");
    const cancelled = await meeting(ana, soon, "confirmed", "Visita cancelada");
    await markAppointmentStatus({ agencyId, userId: ana, role: "broker" }, cancelled.appointmentId, "cancelled");
    const list = await listLeads(
      { agencyId, defaultOwnLeadsOnly: false },
      { filter: "visita_marcada", mine: false, userId: carla, page: 1 },
    );
    const names = list.rows.map((row) => row.name);
    assert.ok(names.includes("Com visita"));
    assert.ok(!names.includes("Visita cancelada"), "stage is still scheduled, but nothing is booked");
    void booked;
  });

  await t.test("looking back: the last days, most recent first, 'Ontem' by name, nothing still to come", async () => {
    await meeting(ana, new Date("2030-01-06T15:00:00Z"), "confirmed", "Domingo"); // yesterday 12h
    await meeting(ana, new Date("2030-01-03T13:00:00Z"), "confirmed", "Quinta"); // Thursday 10h
    await meeting(ana, new Date("2030-01-03T18:00:00Z"), "confirmed", "Quinta tarde"); // Thursday 15h
    const groups = await listAppointments(
      { agencyId, userId: ana, role: "broker" },
      { from: new Date("2029-12-08T03:00:00Z"), to: NOW },
      NOW,
      "desc",
    );
    assert.deepEqual(
      groups.map((group) => [group.label, group.rows.map((row) => `${row.time} ${row.leadName}`)]),
      [
        ["Ontem", ["12h Domingo"]],
        ["qui 03/01", ["15h Quinta tarde", "10h Quinta"]],
      ],
    );
  });

  await t.test("a broker with nothing booked gets an empty agenda", async () => {
    const nobody = await user("Dora", "broker");
    assert.deepEqual(await listAppointments({ agencyId, userId: nobody, role: "broker" }, RANGE, NOW), []);
  });
});
