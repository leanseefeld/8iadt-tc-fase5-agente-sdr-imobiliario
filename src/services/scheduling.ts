import { and, asc, count, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { appointments, events, leads, properties, users } from "../db/schema.ts";
import { getConfig } from "../core/config.ts";
import { canTransition, isLeadStage } from "../domain/lead-status.ts";
import {
  MEETING_MINUTES,
  checkSlot,
  nextBrokerInRotation,
  proposeSlots,
  type Availability,
  type Interval,
  type MeetingType,
  type Option,
  type Preference,
  type SlotRules,
} from "../domain/scheduling.ts";
import type { Intent } from "../domain/slots.ts";

/**
 * Proposing and booking meetings (spec 006).
 *
 * Two rules hold everywhere in this file, because spec 009's reschedule and
 * cancel are built on top of it and must stay two small tools:
 *
 * - **Every status change goes through `transitionAppointment`.** Nothing else
 *   writes `appointments.status`.
 * - **Every time is judged by `checkSlot`** — the same function that produced
 *   the options — so an option can never be offered that booking then refuses.
 *
 * And one that protects the team (FR-005e): nothing returned towards the agent
 * carries a broker's name. The broker's id stays in the row and in the service.
 */

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Runner = Db | Tx;

type AppointmentStatus = "proposed" | "confirmed" | "done" | "cancelled";

// ---------------------------------------------------------------------------
// The one transition function
// ---------------------------------------------------------------------------

/**
 * The only legal moves. Spec 009 adds `confirmed → confirmed` at a new instant
 * (reschedule, re-validated by `checkSlot`) and uses `confirmed → cancelled` for
 * a lead-side cancel — both through this function, never beside it.
 */
const ALLOWED: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  proposed: ["confirmed", "cancelled"],
  confirmed: ["done", "cancelled"],
  done: [],
  cancelled: [],
};

/**
 * Move one appointment from `from` to `to`, optionally setting its instant.
 * Conditional on the row still being in `from`, so two writers racing on the
 * same row cannot both win; returns whether this one did.
 */
export async function transitionAppointment(
  runner: Runner,
  appointmentId: string,
  from: AppointmentStatus,
  to: AppointmentStatus,
  patch: { scheduledAt?: Date } = {},
): Promise<boolean> {
  if (!ALLOWED[from].includes(to)) {
    throw new Error(`appointment transition ${from} → ${to} is not allowed`);
  }
  const rows = await runner
    .update(appointments)
    .set({ status: to, ...patch })
    .where(and(eq(appointments.id, appointmentId), eq(appointments.status, from)))
    .returning({ id: appointments.id });
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** A broker's confirmed meetings from a meeting-length ago onwards. Proposals never block (FR-004). */
export async function loadBusyIntervals(brokerId: string, runner: Runner = getDb(), now = new Date()): Promise<Interval[]> {
  const rows = await runner
    .select({ scheduledAt: appointments.scheduledAt })
    .from(appointments)
    .where(
      and(
        eq(appointments.brokerId, brokerId),
        eq(appointments.status, "confirmed"),
        gte(appointments.scheduledAt, new Date(now.getTime() - MEETING_MINUTES * 60_000)),
      ),
    );
  return rows.map(({ scheduledAt }) => ({
    start: scheduledAt,
    end: new Date(scheduledAt.getTime() + MEETING_MINUTES * 60_000),
  }));
}

/** The broker's own week, as seeded. Nothing writes it in this slice (backlog 34). */
export async function loadBrokerAvailability(brokerId: string, runner: Runner = getDb()): Promise<Availability> {
  const [row] = await runner.select({ availability: users.availability }).from(users).where(eq(users.id, brokerId));
  return (row?.availability ?? {}) as Availability;
}

function slotRules(availability: Availability, type: MeetingType): SlotRules {
  const config = getConfig();
  return {
    availability,
    minNoticeMinutes: config.SCHEDULING_MIN_NOTICE_MINUTES,
    preferredTimes: config.SCHEDULING_PREFERRED_TIMES,
    timezone: config.FOLLOWUP_TIMEZONE,
    type,
  };
}

// ---------------------------------------------------------------------------
// Proposing: compute (reads only), then record
// ---------------------------------------------------------------------------

export type ComputeInput = {
  agencyId: string;
  leadId: string;
  intent: Intent;
  propertyId?: string | null;
  constraint?: Preference;
  now?: Date;
};

export type Computed = {
  brokerId: string;
  type: MeetingType;
  propertyId: string | null;
  options: Option[];
};

export type Unavailable = { unavailable: true; reason: "no_brokers" | "no_slots" | "no_slots_for_constraint" };

/**
 * FR-003: the lead's broker if it already has one; otherwise rotation among the
 * agency's brokers whose specializations include the intent, falling back to
 * every broker. Reads only — the assignment is written by `recordProposal`.
 */
async function chooseBroker(runner: Runner, agencyId: string, leadId: string, intent: Intent): Promise<string | null> {
  const [lead] = await runner.select({ assignedBrokerId: leads.assignedBrokerId }).from(leads).where(eq(leads.id, leadId));
  if (lead?.assignedBrokerId) return lead.assignedBrokerId;

  const brokers = await runner
    .select({ id: users.id, specializations: users.specializations })
    .from(users)
    .where(and(eq(users.agencyId, agencyId), eq(users.role, "broker")))
    .orderBy(asc(users.createdAt), asc(users.id));
  if (brokers.length === 0) return null;

  const specialists = brokers.filter((broker) => broker.specializations.includes(intent));
  const pool = (specialists.length > 0 ? specialists : brokers).map((broker) => broker.id);

  const tallies = await runner
    .select({ brokerId: leads.assignedBrokerId, total: count() })
    .from(leads)
    .where(and(eq(leads.agencyId, agencyId), isNotNull(leads.assignedBrokerId), inArray(leads.assignedBrokerId, pool)))
    .groupBy(leads.assignedBrokerId);
  const counts: Record<string, number> = {};
  for (const { brokerId, total } of tallies) if (brokerId !== null) counts[brokerId] = Number(total);

  return nextBrokerInRotation(pool, counts);
}

/**
 * Options for a lead, **writing nothing** (plan step 3a). Spec 009's reschedule
 * reuses this for a confirmed appointment. An `investment` lead always gets a
 * `call` with no property (FR-003a); otherwise a viewing when a property is in
 * play, a call when none is.
 */
export async function computeOptions(input: ComputeInput, runner: Runner = getDb()): Promise<Computed | Unavailable> {
  const brokerId = await chooseBroker(runner, input.agencyId, input.leadId, input.intent);
  if (brokerId === null) return { unavailable: true, reason: "no_brokers" };

  const investing = input.intent === "investment";
  const propertyId = investing ? null : (input.propertyId ?? null);
  const type: MeetingType = investing || propertyId === null ? "call" : "viewing";

  const now = input.now ?? new Date();
  const rules = slotRules(await loadBrokerAvailability(brokerId, runner), type);
  const busy = await loadBusyIntervals(brokerId, runner, now);
  const options = proposeSlots(busy, now, rules, input.constraint ?? {});

  if (options.length === 0) {
    const constrained = input.constraint?.weekday !== undefined || input.constraint?.period !== undefined;
    return { unavailable: true, reason: constrained ? "no_slots_for_constraint" : "no_slots" };
  }
  return { brokerId, type, propertyId, options };
}

/**
 * Record a proposal: cancel the conversation's open one, insert the new one, and
 * assign the broker if the lead had none (FR-003, FR-004). Cancel-then-insert,
 * both through the transition rule — "at most one open proposal per
 * conversation" is kept here rather than by a unique index.
 *
 * The row holds the first option's instant; the full list travels with the
 * agent message that presents it (clarification of 05/09).
 */
export async function recordProposal(
  ctx: { agencyId: string; conversationId: string; leadId: string },
  computed: Computed,
): Promise<{ appointmentId: string; options: Option[] }> {
  return getDb().transaction(async (tx) => {
    const open = await tx
      .select({ id: appointments.id })
      .from(appointments)
      .where(and(eq(appointments.conversationId, ctx.conversationId), eq(appointments.status, "proposed")));
    for (const { id } of open) await transitionAppointment(tx, id, "proposed", "cancelled");

    const [inserted] = await tx
      .insert(appointments)
      .values({
        agencyId: ctx.agencyId,
        leadId: ctx.leadId,
        conversationId: ctx.conversationId,
        brokerId: computed.brokerId,
        propertyId: computed.propertyId,
        scheduledAt: computed.options[0].scheduledAt,
        type: computed.type,
        status: "proposed",
      })
      .returning({ id: appointments.id });

    await tx
      .update(leads)
      .set({ assignedBrokerId: computed.brokerId, updatedAt: new Date() })
      .where(and(eq(leads.id, ctx.leadId), sql`${leads.assignedBrokerId} is null`));

    await tx.insert(events).values({
      agencyId: ctx.agencyId,
      leadId: ctx.leadId,
      conversationId: ctx.conversationId,
      type: "appointment.proposed",
      actorType: "agent",
      payload: { appointmentId: inserted.id },
    });

    return { appointmentId: inserted.id, options: computed.options };
  });
}

export type ProposeResult =
  | { ok: true; appointmentId: string; options: Option[] }
  | { ok: false; reason: Unavailable["reason"] };

/** `computeOptions` then `recordProposal`. Returns no broker name (FR-005e). */
export async function proposeAppointment(
  input: ComputeInput & { conversationId: string },
): Promise<ProposeResult> {
  const computed = await computeOptions(input);
  if ("unavailable" in computed) return { ok: false, reason: computed.reason };
  const recorded = await recordProposal(input, computed);
  return { ok: true, ...recorded };
}

/** FR-005a: close the open proposal. False when there was none to close. */
export async function declineProposal(conversationId: string): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const open = await tx
      .select({ id: appointments.id })
      .from(appointments)
      .where(and(eq(appointments.conversationId, conversationId), eq(appointments.status, "proposed")));
    let closed = false;
    for (const { id } of open) closed = (await transitionAppointment(tx, id, "proposed", "cancelled")) || closed;
    return closed;
  });
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

export type BookInput = {
  conversationId: string;
  /** 1-based, as the lead sees the list: "a segunda" is 2. */
  choice: { optionIndex: number } | { scheduledAt: Date };
  /** The options last presented, from the message that carried them. */
  offered?: Date[];
  now?: Date;
};

export type BookResult =
  | { ok: true; appointmentId: string; scheduledAt: Date; type: MeetingType; propertyCode: string | null }
  | { ok: false; reason: "no_proposal" | "no_such_option" | "too_soon" | "unavailable" | "collision" };

/**
 * FR-005, FR-006: validate the chosen time with the same rule that produced the
 * options, then confirm the open proposal at that time — or say why not and
 * touch nothing. A transaction-scoped advisory lock on the broker makes two
 * leads racing for the same hour queue behind each other, so the loser sees the
 * winner's confirmed row and gets `collision` (SC-003's second half).
 */
export async function bookAppointment(input: BookInput): Promise<BookResult> {
  return getDb().transaction(async (tx) => {
    const [proposal] = await tx
      .select()
      .from(appointments)
      .where(and(eq(appointments.conversationId, input.conversationId), eq(appointments.status, "proposed")))
      .limit(1);
    if (proposal === undefined) return { ok: false, reason: "no_proposal" };

    const at =
      "optionIndex" in input.choice ? input.offered?.[input.choice.optionIndex - 1] : input.choice.scheduledAt;
    if (at === undefined) return { ok: false, reason: "no_such_option" };

    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${proposal.brokerId}))`);

    const now = input.now ?? new Date();
    const rules = slotRules(await loadBrokerAvailability(proposal.brokerId, tx), proposal.type);
    const verdict = checkSlot(at, await loadBusyIntervals(proposal.brokerId, tx, now), now, rules);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };

    const moved = await transitionAppointment(tx, proposal.id, "proposed", "confirmed", { scheduledAt: at });
    if (!moved) return { ok: false, reason: "no_proposal" };

    // FR-006: scheduled, whatever the conversation's state — forward only (ADR 19).
    const [lead] = await tx.select({ status: leads.status }).from(leads).where(eq(leads.id, proposal.leadId));
    if (lead !== undefined && isLeadStage(lead.status) && canTransition(lead.status, "scheduled")) {
      await tx.update(leads).set({ status: "scheduled", updatedAt: new Date() }).where(eq(leads.id, proposal.leadId));
      await tx.insert(events).values({
        agencyId: proposal.agencyId,
        leadId: proposal.leadId,
        conversationId: proposal.conversationId,
        type: "lead.status_changed",
        actorType: "agent",
        payload: { from: lead.status, to: "scheduled" },
      });
    }

    await tx.insert(events).values({
      agencyId: proposal.agencyId,
      leadId: proposal.leadId,
      conversationId: proposal.conversationId,
      type: "appointment.confirmed",
      actorType: "agent",
      payload: { appointmentId: proposal.id },
    });

    let propertyCode: string | null = null;
    if (proposal.propertyId !== null) {
      const [property] = await tx.select({ code: properties.code }).from(properties).where(eq(properties.id, proposal.propertyId));
      propertyCode = property?.code ?? null;
    }

    return { ok: true, appointmentId: proposal.id, scheduledAt: at, type: proposal.type, propertyCode };
  });
}

/**
 * Does the lead already hold a confirmed meeting still to come? Several bookings
 * per lead are spec 009; until then an interest or a request for times with one
 * booked gets spec 007 FR-023's honest reply (FR-004d). Also the base of the
 * dashboard's derived *Visita marcada* (FR-008b).
 */
export async function hasConfirmedFutureAppointment(leadId: string, now = new Date(), runner: Runner = getDb()): Promise<boolean> {
  const rows = await runner
    .select({ id: appointments.id })
    .from(appointments)
    .where(and(eq(appointments.leadId, leadId), eq(appointments.status, "confirmed"), gte(appointments.scheduledAt, now)))
    .limit(1);
  return rows.length > 0;
}
