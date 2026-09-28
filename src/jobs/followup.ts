import { eq, sql } from "drizzle-orm";
import { writeFollowup, type FollowupInput, type FollowupMessage } from "../agent/followup-writer.ts";
import { webChannel } from "../channels/web.ts";
import type { OutboundMessage } from "../channels/types.ts";
import { getConfig } from "../core/config.ts";
import { withTurnTrace } from "../core/langfuse.ts";
import { conversations, events, followupJobs, users } from "../db/schema.ts";
import {
  cancelIneligibleAttempt,
  followupDelayMinutes,
  followupEligibility,
  nextSendingTime,
  type FollowupContext,
} from "../services/followup.ts";
import type { SweepConsumer, SweepContext } from "./consumers.ts";

/**
 * The follow-up consumer (spec 006 FR-011 to FR-016): one pass of the worker's
 * sweep sends every attempt that is due, and nothing else.
 *
 * **The claim** is `FOR UPDATE SKIP LOCKED` inside one `UPDATE … RETURNING`,
 * so two workers over the same backlog each get a disjoint batch (SC-005). A row
 * left `running` by a worker that died mid-send is reclaimed after ten minutes.
 *
 * **Eligibility is checked twice** (FR-012): right after the claim, because the
 * wait for the sweep is long enough for things to change; and again right
 * before the send, because composing is long enough for the lead to reply.
 *
 * **A failed compose or send consumes nothing** (FR-013): the row goes back to
 * `pending` at its own due time, and the next sweep tries again.
 */

const STALE_RUNNING_MINUTES = 10;
const MINUTE = 60_000;

export type SweepOutcome =
  | { jobId: string; outcome: "sent"; attempt: number; traceId: string | null }
  | { jobId: string; outcome: "rescheduled"; to: Date }
  | { jobId: string; outcome: "cancelled"; reason: string }
  | { jobId: string; outcome: "failed"; error: string };

export interface FollowupDeps {
  write: (input: FollowupInput) => Promise<FollowupMessage>;
  send: (message: OutboundMessage) => Promise<void>;
}

const DEFAULT_DEPS: FollowupDeps = {
  write: writeFollowup,
  // Only the web channel exists (FR-015's abstraction is what makes a second one
  // an adapter, not a change here).
  send: (message) => webChannel.send(message),
};

interface ClaimedRow extends Record<string, unknown> {
  id: string;
  conversation_id: string;
}

export const followup: SweepConsumer = {
  name: "followup",
  async run(ctx: SweepContext): Promise<void> {
    await sweepFollowups(ctx);
  },
};

/**
 * Narrows the claim. Production sweeps claim every agency's due attempts; a
 * test that pins the clock years ahead must not claim the demo's real ones.
 */
export interface SweepScope {
  agencyId?: string;
  conversationIds?: string[];
}

export async function sweepFollowups(
  ctx: SweepContext,
  deps: FollowupDeps = DEFAULT_DEPS,
  scope: SweepScope = {},
): Promise<SweepOutcome[]> {
  const config = getConfig();
  // The sweep's instant, advanced by real elapsed time: the second eligibility
  // check and the next attempt's due time are "later" without leaving the
  // clock the caller chose (which is what lets a test pin the window).
  const started = Date.now();
  const clock = () => new Date(ctx.now.getTime() + (Date.now() - started));
  const claimed = await ctx.db.execute<ClaimedRow>(sql`
    update followup_jobs set status = 'running', locked_at = ${ctx.now}
     where id in (
       select id from followup_jobs
        where ((status = 'pending' and scheduled_for <= ${ctx.now})
           or (status = 'running' and locked_at < ${new Date(ctx.now.getTime() - STALE_RUNNING_MINUTES * MINUTE)}))
          ${scope.agencyId === undefined ? sql`` : sql`and agency_id = ${scope.agencyId}`}
          ${scope.conversationIds === undefined ? sql`` : sql`and conversation_id in (${sql.join(scope.conversationIds.map((id) => sql`${id}`), sql`, `)})`}
        order by scheduled_for
        limit ${config.FOLLOWUP_BATCH_SIZE}
        for update skip locked
     )
    returning id, conversation_id`);

  const outcomes: SweepOutcome[] = [];
  for (const row of claimed.rows) {
    const outcome = await processOne(ctx, deps, clock, row.id, row.conversation_id);
    outcomes.push(outcome);
    ctx.log.info({ conversationId: row.conversation_id, ...outcome }, "follow-up");
  }
  return outcomes;
}

async function release(ctx: SweepContext, jobId: string): Promise<void> {
  // Back to pending at its own due time: no attempt consumed (FR-013).
  await ctx.db.update(followupJobs).set({ status: "pending", lockedAt: null }).where(eq(followupJobs.id, jobId));
}

/** FR-013: outside the window moves the attempt; anything else cancels it. */
async function ineligible(
  ctx: SweepContext,
  jobId: string,
  conversationId: string,
  reason: string,
): Promise<SweepOutcome> {
  if (reason === "outside_window") {
    const to = nextSendingTime(ctx.now);
    await ctx.db
      .update(followupJobs)
      .set({ status: "pending", lockedAt: null, scheduledFor: to })
      .where(eq(followupJobs.id, jobId));
    return { jobId, outcome: "rescheduled", to };
  }
  await cancelIneligibleAttempt(ctx.db, jobId, conversationId);
  return { jobId, outcome: "cancelled", reason };
}

async function processOne(
  ctx: SweepContext,
  deps: FollowupDeps,
  clock: () => Date,
  jobId: string,
  conversationId: string,
): Promise<SweepOutcome> {
  const first = await followupEligibility(ctx.db, conversationId, ctx.now);
  if (!first.ok) return ineligible(ctx, jobId, conversationId, first.reason);
  const context = first.context;

  const proposal = await ctx.db.execute(sql`
    select 1 from appointments where conversation_id = ${conversationId} and status = 'proposed' limit 1`);
  const team = await ctx.db.select({ name: users.name }).from(users).where(eq(users.agencyId, context.agencyId));

  return withTurnTrace(
    {
      traceName: "followup.send",
      agencyId: context.agencyId,
      leadId: context.leadId,
      conversationId,
      channel: context.channel,
      intent: context.intent,
      pendingSlot: null,
      leadName: context.leadName,
      leadText: "(follow-up)",
    },
    async (trace) => {
      let message: FollowupMessage;
      try {
        message = await deps.write({
          intent: context.intent,
          slots: context.slots,
          summary: context.summary,
          leadName: context.leadName,
          proposalOpen: proposal.rows.length > 0,
          teamNames: team.map((member) => member.name),
        });
      } catch (error) {
        await release(ctx, jobId);
        return { jobId, outcome: "failed" as const, error: (error as Error).message };
      }

      // FR-012's second check: the lead may have written while we composed.
      const second = await followupEligibility(ctx.db, conversationId, clock());
      if (!second.ok) return ineligible(ctx, jobId, conversationId, second.reason);

      try {
        await deps.send({ conversationId, text: message.text, isFollowUp: true });
      } catch (error) {
        await release(ctx, jobId);
        return { jobId, outcome: "failed" as const, error: (error as Error).message };
      }

      const attempt = await recordSent(ctx, jobId, context, trace.traceId, message.opening, clock());
      trace.finish({ score: 0, stage: "", outcome: "followup_sent", reply: message.text });
      return { jobId, outcome: "sent" as const, attempt, traceId: trace.traceId };
    },
  );
}

/** FR-016: count it, schedule the next at the backed-off interval, or give up as *Sem resposta*. */
async function recordSent(
  ctx: SweepContext,
  jobId: string,
  context: FollowupContext,
  traceId: string | null,
  opening: FollowupMessage["opening"],
  sentAt: Date,
): Promise<number> {
  const config = getConfig();
  const attempt = context.attempts + 1;
  const exhausted = attempt >= config.FOLLOWUP_MAX_ATTEMPTS;

  await ctx.db.transaction(async (tx) => {
    await tx.update(followupJobs).set({ status: "sent", sentAt }).where(eq(followupJobs.id, jobId));
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
      actorType: "worker",
      traceId,
      payload: { attempt, opening, exhausted },
      createdAt: sentAt,
    });
  });
  return attempt;
}
