import { and, asc, eq } from "drizzle-orm";
import { getConfig } from "../core/config.ts";
import { FOLLOWUP_DUE_CHANNEL, publishQuietly } from "../core/notifier.ts";
import { getDb } from "../db/client.ts";
import { agencies, appointments, conversations, events, followupJobs, leads, properties } from "../db/schema.ts";
import { isWithinWindow, localParts, nextWindowOpening, type MeetingType } from "../domain/scheduling.ts";
import type { LeadScope } from "./auth.ts";
import { agencyWindow, followupEligibility, recordFollowupSent, type Result } from "./followup.ts";
import { recordOutboundMessage } from "./conversation.ts";

/**
 * The follow-up queue (spec 017, backlog item 23): what goes out next, and the
 * two things a person may do about it — send it now, or cancel it.
 *
 * Nothing here sends a composed message. *Enviar agora* makes the job due with
 * `bypass_window` and rings the worker, which sends it through the one path
 * every follow-up takes (composed at send time, eligibility checked twice).
 * The one exception is *Eu escrevo*: the broker's own text, which is theirs
 * and needs no composing, goes out here as their message.
 */

export type QueueKind = "followup" | "reminder";

export interface QueueRow {
  jobId: string;
  kind: QueueKind;
  /** When the job is due. */
  dueAt: Date;
  /** When it will really go: a follow-up due while the window is closed waits for it to open. */
  goesAt: Date;
  leadId: string;
  leadName: string | null;
  assignedBrokerId: string | null;
  /** Follow-ups: which attempt, of how many. */
  attempt: number;
  maxAttempts: number;
  previewLine: string | null;
  /** Reminders: the meeting it announces. */
  meeting: { scheduledAt: Date; type: MeetingType; propertyCode: string | null } | null;
  /** Why *Enviar agora* would be refused, in words; `null` when it would go. */
  blocker: string | null;
}

export interface QueueGroup {
  /** "Hoje", "Amanhã", "Depois". */
  label: string;
  rows: QueueRow[];
}

const SWITCHED_OFF = "O follow-up automático está desligado nesta imobiliária.";
const REMINDERS_OFF = "Os lembretes estão desligados nesta imobiliária.";
const OPTED_OUT = "O lead pediu para não receber mensagens.";
const CLOSED = "Esta conversa foi encerrada.";
const HELD = "Um corretor está com a conversa.";
const GONE = "Esta mensagem já saiu ou foi cancelada.";

/** Every pending job of the agency, soonest first, grouped by the day it really goes. */
export async function listQueue(
  scope: LeadScope,
  filter: { ownerId?: string } = {},
  now: Date = new Date(),
): Promise<QueueGroup[]> {
  const config = getConfig();
  const conditions = [eq(followupJobs.agencyId, scope.agencyId), eq(followupJobs.status, "pending")];
  if (filter.ownerId !== undefined) conditions.push(eq(leads.assignedBrokerId, filter.ownerId));

  const rows = await getDb()
    .select({
      jobId: followupJobs.id,
      kind: followupJobs.kind,
      dueAt: followupJobs.scheduledFor,
      bypassWindow: followupJobs.bypassWindow,
      attempt: followupJobs.attempt,
      leadId: leads.id,
      leadName: leads.name,
      assignedBrokerId: leads.assignedBrokerId,
      doNotContact: leads.doNotContact,
      previewLine: conversations.previewLine,
      conversationStatus: conversations.status,
      slots: conversations.slots,
      followupEnabled: agencies.followupEnabled,
      remindersEnabled: agencies.remindersEnabled,
      windowStart: agencies.followupWindowStart,
      windowEnd: agencies.followupWindowEnd,
      windowDays: agencies.followupWindowDays,
      meetingAt: appointments.scheduledAt,
      meetingType: appointments.type,
      propertyCode: properties.code,
    })
    .from(followupJobs)
    .innerJoin(conversations, eq(conversations.id, followupJobs.conversationId))
    .innerJoin(leads, eq(leads.id, conversations.leadId))
    .innerJoin(agencies, eq(agencies.id, followupJobs.agencyId))
    .leftJoin(appointments, eq(appointments.id, followupJobs.appointmentId))
    .leftJoin(properties, eq(properties.id, appointments.propertyId))
    .where(and(...conditions))
    .orderBy(asc(followupJobs.scheduledFor));

  const timeZone = config.FOLLOWUP_TIMEZONE;
  const queue: QueueRow[] = rows.map((row) => {
    const window = agencyWindow(row);
    const reminder = row.kind === "reminder";
    const from = row.dueAt > now ? row.dueAt : now;
    const goesAt = reminder || row.bypassWindow || isWithinWindow(from, window) ? from : nextWindowOpening(from, window);
    return {
      jobId: row.jobId,
      kind: row.kind,
      dueAt: row.dueAt,
      goesAt,
      leadId: row.leadId,
      leadName: row.leadName ?? (typeof row.slots.name === "string" ? row.slots.name : null),
      assignedBrokerId: row.assignedBrokerId,
      attempt: row.attempt,
      maxAttempts: config.FOLLOWUP_MAX_ATTEMPTS,
      previewLine: row.previewLine,
      meeting:
        reminder && row.meetingAt !== null && row.meetingType !== null
          ? { scheduledAt: row.meetingAt, type: row.meetingType, propertyCode: row.propertyCode }
          : null,
      blocker: blockerFor({ ...row, reminder }),
    };
  });
  queue.sort((a, b) => a.goesAt.getTime() - b.goesAt.getTime());

  const today = localParts(now, timeZone);
  const tomorrow = localParts(new Date(now.getTime() + 24 * 60 * 60_000), timeZone);
  const sameDay = (a: Date, day: typeof today) => {
    const local = localParts(a, timeZone);
    return local.year === day.year && local.month === day.month && local.day === day.day;
  };
  const groups: QueueGroup[] = [];
  for (const row of queue) {
    const label = sameDay(row.goesAt, today) ? "Hoje" : sameDay(row.goesAt, tomorrow) ? "Amanhã" : "Depois";
    let group = groups.at(-1);
    if (group?.label !== label) {
      group = { label, rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups;
}

function blockerFor(row: {
  reminder: boolean;
  followupEnabled: boolean;
  remindersEnabled: boolean;
  doNotContact: boolean;
  conversationStatus: "active" | "paused" | "closed";
}): string | null {
  if (row.doNotContact) return OPTED_OUT;
  if (row.conversationStatus === "closed") return CLOSED;
  if (row.reminder) return row.remindersEnabled ? null : REMINDERS_OFF;
  if (!row.followupEnabled) return SWITCHED_OFF;
  // Spec 017: a reminder may interrupt a broker; a follow-up may not.
  if (row.conversationStatus === "paused") return HELD;
  return null;
}

interface JobRow {
  id: string;
  kind: QueueKind;
  conversationId: string;
  leadId: string;
  agencyId: string;
  appointmentId: string | null;
  reminder: boolean;
  followupEnabled: boolean;
  remindersEnabled: boolean;
  doNotContact: boolean;
  conversationStatus: "active" | "paused" | "closed";
}

/** The pending job, inside the agency — `null` when it is gone, ran or belongs elsewhere. */
async function pendingJob(scope: LeadScope, jobId: string): Promise<JobRow | null> {
  const [row] = await getDb()
    .select({
      id: followupJobs.id,
      kind: followupJobs.kind,
      conversationId: followupJobs.conversationId,
      appointmentId: followupJobs.appointmentId,
      leadId: conversations.leadId,
      agencyId: followupJobs.agencyId,
      followupEnabled: agencies.followupEnabled,
      remindersEnabled: agencies.remindersEnabled,
      doNotContact: leads.doNotContact,
      conversationStatus: conversations.status,
    })
    .from(followupJobs)
    .innerJoin(conversations, eq(conversations.id, followupJobs.conversationId))
    .innerJoin(leads, eq(leads.id, conversations.leadId))
    .innerJoin(agencies, eq(agencies.id, followupJobs.agencyId))
    .where(
      and(
        eq(followupJobs.id, jobId),
        eq(followupJobs.agencyId, scope.agencyId),
        eq(followupJobs.status, "pending"),
      ),
    );
  return row === undefined ? null : { ...row, reminder: row.kind === "reminder" };
}

/**
 * *Enviar agora*: due now, past the window — and only the window. Everything
 * else that would stop the send still stops it, here in words and again in
 * the sweep. The worker is rung so "now" is seconds, not the next tick.
 */
export async function sendNow(scope: LeadScope, userId: string, jobId: string, now: Date = new Date()): Promise<Result> {
  const job = await pendingJob(scope, jobId);
  if (job === null) return { ok: false, message: GONE };
  const blocker = blockerFor(job);
  if (blocker !== null) return { ok: false, message: blocker };

  const moved = await getDb().transaction(async (tx) => {
    const rows = await tx
      .update(followupJobs)
      .set({ scheduledFor: now, bypassWindow: true })
      .where(and(eq(followupJobs.id, jobId), eq(followupJobs.status, "pending")))
      .returning({ id: followupJobs.id });
    if (rows.length === 0) return false;
    await tx.insert(events).values({
      agencyId: job.agencyId,
      leadId: job.leadId,
      conversationId: job.conversationId,
      type: job.reminder ? "reminder.sent_now" : "followup.sent_now",
      actorType: "user",
      actorUserId: userId,
      payload: { jobId },
      createdAt: now,
    });
    return true;
  });
  if (!moved) return { ok: false, message: GONE };
  publishQuietly(FOLLOWUP_DUE_CHANNEL, { jobId });
  return { ok: true };
}

/**
 * *Eu escrevo* (follow-ups only): the broker's text goes out as their message
 * and counts as the attempt. It is not kept anywhere but the conversation.
 * The conversation stays with Sofia, who reads the broker's line next turn.
 */
export async function sendOwnFollowup(
  scope: LeadScope,
  userId: string,
  jobId: string,
  text: string,
  now: Date = new Date(),
): Promise<Result> {
  const content = text.trim();
  if (content === "") return { ok: false, message: "Escreva a mensagem antes de enviar." };
  const job = await pendingJob(scope, jobId);
  if (job === null) return { ok: false, message: GONE };
  if (job.reminder) return { ok: false, message: "O lembrete é escrito pelo sistema." };
  const blocker = blockerFor(job);
  if (blocker !== null) return { ok: false, message: blocker };
  const verdict = await followupEligibility(getDb(), job.conversationId, now, { bypassWindow: true });
  if (!verdict.ok) return { ok: false, message: GONE };

  // Claimed first, so the worker cannot send Sofia's version meanwhile.
  const claimed = await getDb()
    .update(followupJobs)
    .set({ status: "running", lockedAt: now })
    .where(and(eq(followupJobs.id, jobId), eq(followupJobs.status, "pending")))
    .returning({ id: followupJobs.id });
  if (claimed.length === 0) return { ok: false, message: GONE };

  const written = await recordOutboundMessage({
    conversationId: job.conversationId,
    role: "broker",
    userId,
    content,
    isFollowUp: true,
    now,
  });
  if (written === null) {
    await getDb().update(followupJobs).set({ status: "pending", lockedAt: null }).where(eq(followupJobs.id, jobId));
    return { ok: false, message: "Não consegui enviar a mensagem. Tente de novo." };
  }
  await recordFollowupSent(getDb(), {
    jobId,
    context: verdict.context,
    sentAt: now,
    traceId: null,
    payload: { writtenBy: "broker" },
    actor: { type: "user", userId },
  });
  return { ok: true };
}

/**
 * *Cancelar*: a follow-up's chain stops until the lead writes again (the next
 * turn queues a fresh one); a reminder, only that reminder.
 */
export async function cancelQueued(scope: LeadScope, userId: string, jobId: string, now: Date = new Date()): Promise<Result> {
  const job = await pendingJob(scope, jobId);
  if (job === null) return { ok: false, message: GONE };
  const done = await getDb().transaction(async (tx) => {
    const rows = await tx
      .update(followupJobs)
      .set({ status: "cancelled" })
      .where(and(eq(followupJobs.id, jobId), eq(followupJobs.status, "pending")))
      .returning({ id: followupJobs.id });
    if (rows.length === 0) return false;
    if (!job.reminder) {
      await tx
        .update(conversations)
        .set({ followupState: "none" })
        .where(and(eq(conversations.id, job.conversationId), eq(conversations.followupState, "pending")));
    }
    await tx.insert(events).values({
      agencyId: job.agencyId,
      leadId: job.leadId,
      conversationId: job.conversationId,
      type: job.reminder ? "reminder.cancelled" : "followup.cancelled",
      actorType: "user",
      actorUserId: userId,
      payload: { jobId, ...(job.appointmentId === null ? {} : { appointmentId: job.appointmentId }) },
      createdAt: now,
    });
    return true;
  });
  return done ? { ok: true } : { ok: false, message: GONE };
}

const NOTHING_PENDING = "Não há follow-up pendente para este lead.";

/** The lead's pending follow-up — the one the drawer's button acts on. */
async function pendingFollowupJobId(scope: LeadScope, leadId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ id: followupJobs.id })
    .from(followupJobs)
    .innerJoin(conversations, eq(conversations.id, followupJobs.conversationId))
    .where(
      and(
        eq(conversations.leadId, leadId),
        eq(followupJobs.agencyId, scope.agencyId),
        eq(followupJobs.kind, "followup"),
        eq(followupJobs.status, "pending"),
      ),
    )
    .orderBy(asc(followupJobs.scheduledFor))
    .limit(1);
  return row?.id ?? null;
}

/** Why the drawer's *Enviar follow-up agora* is unavailable, or `null` when it is. */
export async function triggerNowBlocker(scope: LeadScope, leadId: string): Promise<string | null> {
  const jobId = await pendingFollowupJobId(scope, leadId);
  if (jobId === null) return NOTHING_PENDING;
  const job = await pendingJob(scope, jobId);
  return job === null ? NOTHING_PENDING : blockerFor(job);
}

/** Spec 006 FR-017, through spec 017's *Enviar agora*: the drawer and the queue share one path. */
export async function triggerNow(scope: LeadScope, userId: string, leadId: string, now: Date = new Date()): Promise<Result> {
  const jobId = await pendingFollowupJobId(scope, leadId);
  if (jobId === null) return { ok: false, message: NOTHING_PENDING };
  return sendNow(scope, userId, jobId, now);
}
