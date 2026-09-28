import { and, eq, sql } from "drizzle-orm";
import { getConfig } from "../core/config.ts";
import { getDb } from "../db/client.ts";
import { agencies, conversations, events, followupJobs, leads } from "../db/schema.ts";
import { isWithinWindow, nextWindowOpening } from "../domain/scheduling.ts";
import { EMPTY_SLOTS, nextQuestion, slotsSchema, type Intent, type Slots } from "../domain/slots.ts";
import type { LeadScope } from "./auth.ts";

/**
 * Follow-up: reopening a conversation that went quiet (spec 006 US2).
 *
 * Three moments, three functions, one rule each:
 * - `scheduleFollowup` — a turn left the lead something to answer (FR-009);
 * - `cancelFollowup` — the lead wrote (FR-010);
 * - `followupEligibility` — may this attempt go out now (FR-012, FR-019).
 *
 * Scheduling does not read the agency's switch; sending does. That is FR-019's
 * point: a manager who switches follow-up back on gets the attempts the
 * conversations earned meanwhile, and one who switches it off stops them at
 * the last moment, without anything having to be re-enqueued or swept.
 */

type Runner = ReturnType<typeof getDb> | Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

export type Result = { ok: true } | { ok: false; message: string };

/** Stored slots are parsed, not trusted — the same rule as `readSlots` in the conversation service. */
function readSlotsShape(stored: unknown): Slots {
  const parsed = slotsSchema.safeParse({ ...EMPTY_SLOTS, ...(stored as object) });
  return parsed.success ? parsed.data : { ...EMPTY_SLOTS };
}

const MINUTE = 60_000;

/** The wait before attempt `attempt` (1-based): the first delay, times the factor per attempt already sent. */
export function followupDelayMinutes(attempt: number): number {
  const config = getConfig();
  return config.FOLLOWUP_FIRST_DELAY_MINUTES * config.FOLLOWUP_BACKOFF_FACTOR ** Math.max(0, attempt - 1);
}

/**
 * FR-009. Exactly one pending attempt per conversation, due one first delay
 * from now: repeated turns move it, never add a second. Every guard is in the
 * statement's own `where`, so a paused or closed conversation, an opted-out
 * lead, a confirmed future appointment or the maximum reached writes nothing.
 *
 * Runs inside the caller's transaction, which has already written the
 * conversation row — that row lock is what keeps two turns from inserting two
 * pending attempts.
 */
export async function scheduleFollowup(tx: Runner, conversationId: string, now: Date): Promise<boolean> {
  const config = getConfig();
  const eligible = sql`
    exists (
      select 1
        from conversations c
        join leads l on l.id = c.lead_id
       where c.id = ${conversationId}
         and c.status = 'active'
         and c.held_by_user_id is null
         and l.do_not_contact = false
         and c.followup_attempts < ${config.FOLLOWUP_MAX_ATTEMPTS}
         and not exists (
           select 1 from appointments a
            where a.lead_id = c.lead_id and a.status = 'confirmed' and a.scheduled_at >= ${now}
         )
    )`;

  const attemptsRows = await tx.execute<{ followup_attempts: number }>(
    sql`select followup_attempts from conversations where id = ${conversationId}`,
  );
  const attempt = (attemptsRows.rows[0]?.followup_attempts ?? 0) + 1;
  const due = new Date(now.getTime() + followupDelayMinutes(attempt) * MINUTE);

  const moved = await tx.execute(sql`
    update followup_jobs set scheduled_for = ${due}
     where conversation_id = ${conversationId} and status = 'pending' and ${eligible}
    returning id`);
  if (moved.rows.length === 0) {
    const inserted = await tx.execute(sql`
      insert into followup_jobs (agency_id, conversation_id, attempt, scheduled_for)
      select c.agency_id, c.id, ${attempt}, ${due}
        from conversations c
       where c.id = ${conversationId} and ${eligible}
      returning id`);
    if (inserted.rows.length === 0) return false;
  }

  const [conversation] = await tx
    .update(conversations)
    .set({ followupState: "pending" })
    .where(eq(conversations.id, conversationId))
    .returning({ agencyId: conversations.agencyId, leadId: conversations.leadId });
  await tx.insert(events).values({
    agencyId: conversation.agencyId,
    leadId: conversation.leadId,
    conversationId,
    type: "followup.scheduled",
    actorType: "system",
    payload: { attempt, scheduledFor: due.toISOString() },
    createdAt: now,
  });
  return true;
}

/**
 * FR-010. The lead wrote: every pending attempt goes, the count and the state
 * go back to zero and `none` — which is also what takes the lead out of *Sem
 * resposta*, a view of `followupState`. When a follow-up had already been sent,
 * the lead came back because of it: `followup.recovered`, **once**, because the
 * same statement that reads the old count resets it.
 */
export async function cancelFollowup(tx: Runner, conversationId: string, now: Date): Promise<{ recovered: boolean }> {
  await tx
    .update(followupJobs)
    .set({ status: "cancelled" })
    .where(and(eq(followupJobs.conversationId, conversationId), eq(followupJobs.status, "pending")));

  const reset = await tx.execute<{ before: number; agency_id: string; lead_id: string }>(sql`
    with before as (
      select id, followup_attempts from conversations where id = ${conversationId} for update
    )
    update conversations c
       set followup_attempts = 0, followup_state = 'none'
      from before
     where c.id = before.id
    returning before.followup_attempts as before, c.agency_id, c.lead_id`);
  const row = reset.rows[0];
  const recovered = row !== undefined && Number(row.before) > 0;
  if (recovered) {
    await tx.insert(events).values({
      agencyId: row.agency_id,
      leadId: row.lead_id,
      conversationId,
      type: "followup.recovered",
      actorType: "lead",
      payload: { attemptsSent: Number(row.before) },
      createdAt: now,
    });
  }
  return { recovered };
}

export type Ineligibility =
  | "gone"
  | "not_active"
  | "opted_out"
  | "booked"
  | "max_attempts"
  | "switch_off"
  | "outside_window";

export interface FollowupContext {
  conversationId: string;
  agencyId: string;
  leadId: string;
  channel: "web" | "telegram";
  intent: string;
  slots: Record<string, unknown>;
  summary: string | null;
  leadName: string | null;
  attempts: number;
  followupState: "none" | "pending" | "exhausted";
}

/**
 * FR-012 and FR-019: may an attempt go out **now**? Checked right after the
 * claim and again right before the send, because composing takes long enough
 * for the lead to reply meanwhile. Outside the window is its own answer, since
 * it moves the attempt instead of cancelling it (FR-013).
 */
export async function followupEligibility(
  runner: Runner,
  conversationId: string,
  now: Date,
): Promise<{ ok: true; context: FollowupContext } | { ok: false; reason: Ineligibility; context?: FollowupContext }> {
  const config = getConfig();
  const [row] = await runner
    .select({
      conversationId: conversations.id,
      agencyId: conversations.agencyId,
      leadId: conversations.leadId,
      channel: conversations.channel,
      status: conversations.status,
      heldByUserId: conversations.heldByUserId,
      slots: conversations.slots,
      summary: conversations.summary,
      attempts: conversations.followupAttempts,
      followupState: conversations.followupState,
      intent: leads.intent,
      leadName: leads.name,
      doNotContact: leads.doNotContact,
      followupEnabled: agencies.followupEnabled,
    })
    .from(conversations)
    .innerJoin(leads, eq(leads.id, conversations.leadId))
    .innerJoin(agencies, eq(agencies.id, conversations.agencyId))
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (row === undefined) return { ok: false, reason: "gone" };

  const context: FollowupContext = {
    conversationId: row.conversationId,
    agencyId: row.agencyId,
    leadId: row.leadId,
    channel: row.channel,
    intent: row.intent,
    slots: row.slots,
    summary: row.summary,
    // The lead row gets the name when a turn commits it; the slot has it first.
    leadName: row.leadName ?? (typeof row.slots.name === "string" ? row.slots.name : null),
    attempts: row.attempts,
    followupState: row.followupState,
  };
  const no = (reason: Ineligibility) => ({ ok: false as const, reason, context });

  if (!row.followupEnabled) return no("switch_off");
  if (row.status !== "active" || row.heldByUserId !== null) return no("not_active");
  if (row.doNotContact) return no("opted_out");
  if (row.attempts >= config.FOLLOWUP_MAX_ATTEMPTS) return no("max_attempts");
  const booked = await runner.execute(sql`
    select 1 from appointments
     where lead_id = ${row.leadId} and status = 'confirmed' and scheduled_at >= ${now} limit 1`);
  if (booked.rows.length > 0) return no("booked");
  if (!isWithinWindow(now, windowRules())) return no("outside_window");
  return { ok: true, context };
}

export function windowRules() {
  const config = getConfig();
  return {
    windowStart: config.FOLLOWUP_WINDOW_START,
    windowEnd: config.FOLLOWUP_WINDOW_END,
    timezone: config.FOLLOWUP_TIMEZONE,
  };
}

/** FR-013: the next instant this attempt may go out, when the window is closed. */
export function nextSendingTime(now: Date): Date {
  return nextWindowOpening(now, windowRules());
}

/**
 * FR-013a: an attempt cancelled because the conversation stopped being
 * eligible leaves no *Follow-up pendente* behind it. `exhausted` stays — that
 * is *Sem resposta*, and it is the lead's history, not a pending promise.
 */
export async function cancelIneligibleAttempt(runner: Runner, jobId: string, conversationId: string): Promise<void> {
  await runner.update(followupJobs).set({ status: "cancelled" }).where(eq(followupJobs.id, jobId));
  await runner.execute(sql`
    update conversations set followup_state = 'none'
     where id = ${conversationId} and followup_state = 'pending'
       and not exists (select 1 from followup_jobs where conversation_id = ${conversationId} and status = 'pending')`);
}

/**
 * FR-009a: a conversation handed back to the agent restarts the clock when it
 * still owes the lead something — the script's next question, or an open
 * proposal. An appointment closing never calls this.
 */
export async function restartAfterHandback(conversationId: string, now: Date = new Date()): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ intent: leads.intent, slots: conversations.slots, consentAt: leads.consentAt })
    .from(conversations)
    .innerJoin(leads, eq(leads.id, conversations.leadId))
    .where(eq(conversations.id, conversationId));
  if (row === undefined) return false;
  const proposal = await db.execute(sql`
    select 1 from appointments where conversation_id = ${conversationId} and status = 'proposed' limit 1`);
  const question = nextQuestion(
    { intent: row.intent as Intent, slots: readSlotsShape(row.slots) },
    row.consentAt !== null,
  );
  if (question === null && proposal.rows.length === 0) return false;
  return db.transaction((tx) => scheduleFollowup(tx, conversationId, now));
}

// ---------------------------------------------------------------------------
// The lead drawer and the dashboard switch (FR-017, FR-019)
// ---------------------------------------------------------------------------

const NOTHING_PENDING = "Não há follow-up pendente para este lead.";
const SWITCHED_OFF = "O follow-up automático está desligado nesta imobiliária.";

/** Why the drawer's "Enviar follow-up agora" is unavailable, or `null` when it is. */
export async function triggerNowBlocker(scope: LeadScope, leadId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ enabled: agencies.followupEnabled, pending: sql<number>`count(${followupJobs.id})` })
    .from(leads)
    .innerJoin(agencies, eq(agencies.id, leads.agencyId))
    .innerJoin(conversations, eq(conversations.leadId, leads.id))
    .leftJoin(
      followupJobs,
      and(eq(followupJobs.conversationId, conversations.id), eq(followupJobs.status, "pending")),
    )
    .where(and(eq(leads.id, leadId), eq(leads.agencyId, scope.agencyId)))
    .groupBy(agencies.followupEnabled);
  if (row === undefined) return "Lead não encontrado.";
  if (!row.enabled) return SWITCHED_OFF;
  if (Number(row.pending) === 0) return NOTHING_PENDING;
  return null;
}

/**
 * FR-017: the demo button. Makes the pending attempt due now — the same job,
 * the same sweep, the same send path. Nothing is sent from here.
 */
export async function triggerNow(scope: LeadScope, leadId: string, now: Date = new Date()): Promise<Result> {
  const blocker = await triggerNowBlocker(scope, leadId);
  if (blocker !== null) return { ok: false, message: blocker };
  const moved = await getDb().execute(sql`
    update followup_jobs j set scheduled_for = ${now}
      from conversations c
     where j.conversation_id = c.id and j.status = 'pending'
       and c.lead_id = ${leadId} and c.agency_id = ${scope.agencyId}
    returning j.id`);
  return moved.rows.length > 0 ? { ok: true } : { ok: false, message: NOTHING_PENDING };
}

/** FR-019: the agency-wide switch. A sales manager's alone; a broker only sees it. */
export async function setFollowupEnabled(
  scope: LeadScope,
  role: "broker" | "salesManager",
  userId: string,
  enabled: boolean,
): Promise<Result> {
  if (role !== "salesManager") return { ok: false, message: "Só a gerência pode mudar o follow-up automático." };
  await getDb().transaction(async (tx) => {
    await tx.update(agencies).set({ followupEnabled: enabled }).where(eq(agencies.id, scope.agencyId));
    await tx.insert(events).values({
      agencyId: scope.agencyId,
      type: enabled ? "followup.enabled" : "followup.disabled",
      actorType: "user",
      actorUserId: userId,
      payload: {},
    });
  });
  return { ok: true };
}

export async function isFollowupEnabled(agencyId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ enabled: agencies.followupEnabled })
    .from(agencies)
    .where(eq(agencies.id, agencyId));
  return row?.enabled ?? true;
}
