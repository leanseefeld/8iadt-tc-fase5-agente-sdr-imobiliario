import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { agencies, appointments, conversations, followupJobs, leads, properties } from "../db/schema.ts";
import type { MeetingType } from "../domain/scheduling.ts";
import { assignedBrokerSpecializes } from "./scheduling.ts";

/**
 * The meeting reminder (spec 017): a written message a set time before a
 * confirmed visit or call. It lives in `followup_jobs` as `kind = 'reminder'`,
 * so the sweep, the queue screen, *Enviar agora* and *Cancelar* need nothing
 * of their own — but it is not a follow-up attempt: it never touches
 * `followupAttempts` or `followupState`, and a lead's message does not cancel it.
 *
 * Two moments:
 * - `syncReminder` — an appointment changed status or instant (called from
 *   `transitionAppointment`, the only place that changes them);
 * - `reminderEligibility` — may this reminder go out now.
 */

type Db = ReturnType<typeof getDb>;
type Runner = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const MINUTE = 60_000;

/**
 * Keep the meeting's one pending reminder in step with it. Confirmed and still
 * more than the lead time away: queued at `scheduled_at − lead`, or moved
 * there. Anything else — cancelled, done, or booked inside the lead time (the
 * lead has just confirmed it) — leaves no pending reminder behind.
 */
export async function syncReminder(runner: Runner, appointmentId: string, now: Date = new Date()): Promise<void> {
  const [row] = await runner
    .select({
      status: appointments.status,
      scheduledAt: appointments.scheduledAt,
      agencyId: appointments.agencyId,
      conversationId: appointments.conversationId,
      leadMinutes: agencies.reminderLeadMinutes,
    })
    .from(appointments)
    .innerJoin(agencies, eq(agencies.id, appointments.agencyId))
    .where(eq(appointments.id, appointmentId));
  if (row === undefined) return;

  const pendingReminder = and(
    eq(followupJobs.appointmentId, appointmentId),
    eq(followupJobs.kind, "reminder"),
    eq(followupJobs.status, "pending"),
  );
  const due = new Date(row.scheduledAt.getTime() - row.leadMinutes * MINUTE);
  if (row.status !== "confirmed" || due <= now) {
    await runner.update(followupJobs).set({ status: "cancelled" }).where(pendingReminder);
    return;
  }
  const moved = await runner
    .update(followupJobs)
    .set({ scheduledFor: due, bypassWindow: false })
    .where(pendingReminder)
    .returning({ id: followupJobs.id });
  if (moved.length > 0) return;
  await runner.insert(followupJobs).values({
    agencyId: row.agencyId,
    conversationId: row.conversationId,
    kind: "reminder",
    appointmentId,
    attempt: 0,
    scheduledFor: due,
  });
}

/**
 * The manager changed the lead time: every pending reminder of the agency
 * moves to its meeting minus the new lead, and one whose new instant has
 * already passed goes at the next sweep — the meeting is inside the new lead
 * time, which is what the manager asked for.
 */
export async function retimeReminders(runner: Runner, agencyId: string, leadMinutes: number, now: Date): Promise<void> {
  await runner.execute(sql`
    update followup_jobs j
       set scheduled_for = greatest(a.scheduled_at - make_interval(mins => ${leadMinutes}), ${now})
      from appointments a
     where j.appointment_id = a.id and j.kind = 'reminder' and j.status = 'pending'
       and j.agency_id = ${agencyId}`);
}

export type ReminderSkip = "gone" | "switch_off" | "opted_out" | "not_active" | "meeting_changed";

export interface ReminderContext {
  agencyId: string;
  leadId: string;
  conversationId: string;
  leadName: string | null;
  /** A broker holds the conversation or is awaited on it: Sofia interrupts, and says so. */
  held: boolean;
  meeting: {
    id: string;
    scheduledAt: Date;
    type: MeetingType;
    propertyCode: string | null;
    /** An investor whose broker specializes in investment hears "nosso especialista" (006). */
    investmentSpecialist: boolean;
  };
}

/**
 * Spec 017: a reminder bypasses the window, the attempt cap, the "booked" rule
 * and the follow-up switch. It still needs its own switch on, a lead who has
 * not opted out, a conversation that is not closed, and the meeting still
 * confirmed and not started.
 */
export async function reminderEligibility(
  runner: Runner,
  appointmentId: string,
  now: Date,
): Promise<{ ok: true; context: ReminderContext } | { ok: false; reason: ReminderSkip; context?: ReminderContext }> {
  const [row] = await runner
    .select({
      agencyId: appointments.agencyId,
      leadId: appointments.leadId,
      conversationId: appointments.conversationId,
      status: appointments.status,
      scheduledAt: appointments.scheduledAt,
      type: appointments.type,
      propertyCode: properties.code,
      leadName: leads.name,
      intent: leads.intent,
      doNotContact: leads.doNotContact,
      slots: conversations.slots,
      conversationStatus: conversations.status,
      heldByUserId: conversations.heldByUserId,
      remindersEnabled: agencies.remindersEnabled,
    })
    .from(appointments)
    .innerJoin(leads, eq(leads.id, appointments.leadId))
    .innerJoin(conversations, eq(conversations.id, appointments.conversationId))
    .innerJoin(agencies, eq(agencies.id, appointments.agencyId))
    .leftJoin(properties, eq(properties.id, appointments.propertyId))
    .where(eq(appointments.id, appointmentId));
  if (row === undefined) return { ok: false, reason: "gone" };

  const context: ReminderContext = {
    agencyId: row.agencyId,
    leadId: row.leadId,
    conversationId: row.conversationId,
    leadName: row.leadName ?? (typeof row.slots.name === "string" ? row.slots.name : null),
    held: row.conversationStatus === "paused",
    meeting: {
      id: appointmentId,
      scheduledAt: row.scheduledAt,
      type: row.type,
      propertyCode: row.propertyCode ?? null,
      investmentSpecialist:
        row.type === "call" && row.intent === "investment" && (await assignedBrokerSpecializes(row.leadId, "investment", runner)),
    },
  };
  const no = (reason: ReminderSkip) => ({ ok: false as const, reason, context });

  if (!row.remindersEnabled) return no("switch_off");
  if (row.doNotContact) return no("opted_out");
  if (row.conversationStatus === "closed") return no("not_active");
  if (row.status !== "confirmed" || row.scheduledAt <= now) return no("meeting_changed");
  return { ok: true, context };
}
