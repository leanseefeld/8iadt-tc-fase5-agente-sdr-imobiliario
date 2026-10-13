import { and, eq, sql } from "drizzle-orm";
import { getConfig } from "../core/config.ts";
import { getDb } from "../db/client.ts";
import { agencies, conversations, events, followupJobs, leads } from "../db/schema.ts";
import { isWithinWindow, nextWindowOpening, type Weekday, type WindowRules } from "../domain/scheduling.ts";
import { EMPTY_SLOTS, nextQuestion, slotsSchema, type Intent, type Slots } from "../domain/slots.ts";

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
export async function scheduleFollowup(
  tx: Runner,
  conversationId: string,
  now: Date,
  /** Who left the lead waiting: the agent's turn, or the broker handing back (FR-009a). */
  actor: { type: "agent" } | { type: "user"; userId: string } = { type: "agent" },
): Promise<boolean> {
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
     where conversation_id = ${conversationId} and kind = 'followup' and status = 'pending' and ${eligible}
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
    actorType: actor.type,
    actorUserId: actor.type === "user" ? actor.userId : null,
    payload: { attempt, scheduledFor: due.toISOString() },
    createdAt: now,
  });
  return true;
}

/**
 * FR-010. The lead wrote: every pending attempt goes — follow-ups only; a
 * meeting's reminder stays, since writing does not undo the meeting (spec 017) — the count and the state
 * go back to zero and `none` — which is also what takes the lead out of *Sem
 * resposta*, a view of `followupState`. When a follow-up had already been sent,
 * the lead came back because of it: `followup.recovered`, **once**, because the
 * same statement that reads the old count resets it.
 */
export async function cancelFollowup(tx: Runner, conversationId: string, now: Date): Promise<{ recovered: boolean }> {
  await tx
    .update(followupJobs)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(followupJobs.conversationId, conversationId),
        eq(followupJobs.kind, "followup"),
        eq(followupJobs.status, "pending"),
      ),
    );

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
  /** The agency's sending window (spec 017), read from its row at send time. */
  window: WindowRules;
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
  /** Spec 017's *Enviar agora*: the window, and only the window, does not apply. */
  options: { bypassWindow?: boolean } = {},
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
      windowStart: agencies.followupWindowStart,
      windowEnd: agencies.followupWindowEnd,
      windowDays: agencies.followupWindowDays,
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
    window: agencyWindow(row),
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
  if (options.bypassWindow !== true && !isWithinWindow(now, context.window)) return no("outside_window");
  return { ok: true, context };
}

/** Spec 017: the window as the agency row stores it, in the agency's time zone. */
export function agencyWindow(row: { windowStart: string; windowEnd: string; windowDays: string[] }): WindowRules {
  return {
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    days: row.windowDays as Weekday[],
    timezone: getConfig().FOLLOWUP_TIMEZONE,
  };
}

/** FR-013: the next instant an attempt may go out, when the window is closed. */
export function nextSendingTime(now: Date, window: WindowRules): Date {
  return nextWindowOpening(now, window);
}

/**
 * FR-016: count the attempt, queue the next one at the backed-off interval, or
 * give up as *Sem resposta*. The worker calls it after the agent's follow-up;
 * spec 017's *Eu escrevo* after the broker's own — same count, same chain.
 */
export async function recordFollowupSent(
  runner: Runner,
  input: {
    jobId: string;
    context: Pick<FollowupContext, "agencyId" | "leadId" | "conversationId" | "attempts">;
    sentAt: Date;
    traceId: string | null;
    payload: Record<string, unknown>;
    actor: { type: "worker" } | { type: "user"; userId: string };
  },
): Promise<number> {
  const config = getConfig();
  const { context, sentAt } = input;
  const attempt = context.attempts + 1;
  const exhausted = attempt >= config.FOLLOWUP_MAX_ATTEMPTS;
  const write = async (tx: Parameters<Parameters<Runner["transaction"]>[0]>[0]) => {
    await tx.update(followupJobs).set({ status: "sent", sentAt }).where(eq(followupJobs.id, input.jobId));
    await tx
      .update(conversations)
      .set({ followupAttempts: attempt, followupState: exhausted ? "exhausted" : "pending" })
      .where(eq(conversations.id, context.conversationId));
    if (!exhausted) {
      await tx.insert(followupJobs).values({
        agencyId: context.agencyId,
        conversationId: context.conversationId,
        attempt: attempt + 1,
        scheduledFor: new Date(sentAt.getTime() + followupDelayMinutes(attempt + 1) * MINUTE),
      });
    }
    await tx.insert(events).values({
      agencyId: context.agencyId,
      leadId: context.leadId,
      conversationId: context.conversationId,
      type: "followup.sent",
      actorType: input.actor.type,
      actorUserId: input.actor.type === "user" ? input.actor.userId : null,
      traceId: input.traceId,
      payload: { attempt, exhausted, ...input.payload },
      createdAt: sentAt,
    });
  };
  await runner.transaction(write);
  return attempt;
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
       and not exists (
         select 1 from followup_jobs
          where conversation_id = ${conversationId} and kind = 'followup' and status = 'pending')`);
}

/**
 * FR-009a: a conversation handed back to the agent restarts the clock when it
 * still owes the lead something — the script's next question, or an open
 * proposal. An appointment closing never calls this.
 */
export async function restartAfterHandback(
  conversationId: string,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
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
  return db.transaction((tx) => scheduleFollowup(tx, conversationId, now, { type: "user", userId }));
}

// ---------------------------------------------------------------------------
// The dashboard's status line (FR-019). The switch itself moved to the
// settings screen (spec 017, services/agency-settings.ts); *Enviar agora* to
// the queue (services/followup-queue.ts).
// ---------------------------------------------------------------------------

export async function isFollowupEnabled(agencyId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ enabled: agencies.followupEnabled })
    .from(agencies)
    .where(eq(agencies.id, agencyId));
  return row?.enabled ?? true;
}
