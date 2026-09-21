import { inArray, sql } from "drizzle-orm";
import { summarizeConversation } from "../agent/summarizer.ts";
import { getConfig } from "../core/config.ts";
import { publishQuietly, STATE_CHANNEL } from "../core/notifier.ts";
import { events } from "../db/schema.ts";
import type { SweepConsumer, SweepContext } from "./consumers.ts";

/**
 * The summary consumer: it turns the `conversation.turn` rows of the event
 * outbox into a summary and a preview line for the broker (FR-008 to FR-016).
 *
 * **Why the claim is two steps.** Finding the conversations means grouping —
 * "every conversation with unprocessed turns whose newest is older than the
 * debounce" — and Postgres refuses `FOR UPDATE` beside `GROUP BY`. So the select
 * is unlocked and deliberately optimistic, and the lock is taken per
 * conversation, on its own rows, with `SKIP LOCKED`: whoever gets zero rows back
 * knows another worker has that conversation and moves on. Two workers over one
 * backlog therefore produce one summary per conversation (SC-007).
 *
 * **Why a failure still marks the turns processed.** The alternative is a poison
 * pill: one conversation the model cannot summarise would be retried every
 * sweep, forever, at the cost of a model call each time. The stored summary is
 * left untouched, the failure is logged, and the next lead message produces a
 * fresh turn and a fresh attempt. A summary is never load-bearing (FR-016).
 */

interface PendingRow extends Record<string, unknown> {
  conversation_id: string;
}

interface ClaimedRow extends Record<string, unknown> {
  id: string;
}

interface ContextRow extends Record<string, unknown> {
  agency_id: string;
  status: "active" | "paused" | "closed";
  summary: string | null;
  summary_updated_at: Date | null;
  lead_name: string | null;
}

interface MessageRow extends Record<string, unknown> {
  role: "lead" | "agent" | "broker" | "system";
  content: string;
}

export const summarize: SweepConsumer = {
  name: "summarize",

  async run(ctx: SweepContext): Promise<void> {
    const config = getConfig();

    // Unlocked on purpose: `FOR UPDATE` cannot sit beside `GROUP BY`. The rows
    // are claimed one conversation at a time, below.
    const pending = await ctx.db.execute<PendingRow>(sql`
      select conversation_id
        from events
       where type = 'conversation.turn'
         and processed_at is null
         and conversation_id is not null
       group by conversation_id
      having max(created_at) < now() - make_interval(secs => ${config.SUMMARY_DEBOUNCE_SECONDS})
       order by min(created_at)
       limit ${config.SUMMARY_BATCH_SIZE}
    `);

    if (pending.rows.length === 0) return;
    ctx.log.info({ conversations: pending.rows.length }, "summarising");

    for (const row of pending.rows) {
      await summarizeOne(ctx, row.conversation_id);
    }
  },
};

async function summarizeOne(ctx: SweepContext, conversationId: string): Promise<void> {
  const now = ctx.now;

  // One transaction claims the turns and reads what the call needs. It ends
  // before the model call: holding a row lock across a call that may take
  // thirty seconds would block the other worker for thirty seconds.
  const claim = await ctx.db.transaction(async (tx) => {
    const claimed = await tx.execute<ClaimedRow>(sql`
      select id from events
       where conversation_id = ${conversationId}
         and type = 'conversation.turn'
         and processed_at is null
       for update skip locked
    `);
    if (claimed.rows.length === 0) return null;

    const ids = claimed.rows.map((row) => row.id);

    // Marked handled inside the claiming transaction, so a crash between here
    // and the write leaves them processed and the old summary standing —
    // the same outcome as a failed call, which is the safe one.
    // Through the query builder rather than raw SQL: an array interpolated
    // into a `sql` template becomes one parameter per element, which is not
    // what `= any(…)` takes.
    await tx.update(events).set({ processedAt: now }).where(inArray(events.id, ids));

    const context = await tx.execute<ContextRow>(sql`
      select c.agency_id, c.status, c.summary, c.summary_updated_at, l.name as lead_name
        from conversations c
        join leads l on l.id = c.lead_id
       where c.id = ${conversationId}
    `);

    const since = context.rows[0]?.summary_updated_at ?? null;
    const messages = await tx.execute<MessageRow>(sql`
      select role, content from messages
       where conversation_id = ${conversationId}
         and role in ('lead', 'agent', 'broker')
         and (${since}::timestamptz is null or created_at > ${since})
       order by created_at, id
    `);

    return { ids, context: context.rows[0], messages: messages.rows };
  });

  // Another worker holds this conversation. Not an error, not a retry.
  if (claim === null) return;
  if (claim.context === undefined) return;

  const log = ctx.log.child({ conversationId });

  if (claim.messages.length === 0) {
    log.debug("nothing new to summarise since the last one");
    return;
  }

  try {
    const summary = await summarizeConversation({
      previousSummary: claim.context.summary,
      leadName: claim.context.lead_name,
      messages: claim.messages.map((message) => ({
        role: message.role as "lead" | "agent" | "broker",
        content: message.content,
      })),
    });

    await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`
        update conversations
           set summary = ${summary.summary},
               preview_line = ${summary.previewLine},
               summary_updated_at = ${now},
               updated_at = ${now}
         where id = ${conversationId}
      `);

      await tx.execute(sql`
        insert into events (agency_id, conversation_id, type, actor_type, payload, processed_at)
        values (${claim.context.agency_id}, ${conversationId}, 'summary.updated', 'worker',
                '{}'::jsonb, ${now})
      `);
    });

    // The list shows the preview line, so the dashboard has something to re-read.
    publishQuietly(STATE_CHANNEL, {
      conversationId,
      agencyId: claim.context.agency_id,
      status: claim.context.status,
    });

    log.info({ previewChars: summary.previewLine.length }, "summary stored");
  } catch (error) {
    // The turns stay processed. See the note at the top of this file.
    log.error({ err: (error as Error).message }, "summary failed, keeping the previous one");
  }
}
