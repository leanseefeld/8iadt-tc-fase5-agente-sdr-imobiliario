import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "../../db/client.ts";
import { conversations } from "../../db/schema.ts";
import { getConfig } from "../../core/config.ts";

/** One turn per conversation at a time (FR-043), decided by the row. */

/**
 * A turn left behind by a replica that died is stale once it is older than
 * twice the model timeout — long enough that no live turn is ever stolen,
 * short enough that a lead is not left waiting (FR-046).
 */
export function staleTurnCutoff(now: Date): Date {
  return new Date(now.getTime() - getConfig().MODEL_TIMEOUT_MS * 2);
}

/**
 * FR-043: at most one turn per conversation. The claim is the `UPDATE` itself —
 * whichever caller's row-write wins takes the turn and every other caller sees
 * zero rows back. No advisory lock, no read-then-write, and it works across
 * replicas because the arbiter is the row.
 *
 * A `paused` or `closed` conversation is never claimed: a broker owns it (FR-028).
 */
export async function claimTurn(conversationId: string, now: Date = new Date()): Promise<boolean> {
  const claimed = await getDb()
    .update(conversations)
    .set({ processingSince: now, updatedAt: now })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.status, "active"),
        or(
          isNull(conversations.processingSince),
          lt(conversations.processingSince, staleTurnCutoff(now)),
        ),
      ),
    )
    .returning({ id: conversations.id });

  return claimed.length > 0;
}

/**
 * FR-046: conversations whose lead messages have gone unanswered longer than
 * `CHAT_DEBOUNCE_MS` with nobody working on them — a replica that died mid-turn,
 * or a route handler whose debounce timer went down with it.
 *
 * The predicate is the same one `loadTurn` uses for `unanswered`, so the consumer
 * re-runs exactly the turn the route handler would have run. `paused` and
 * `closed` are excluded here as well as in `claimTurn`: a conversation a broker
 * holds must not be woken by a sweep.
 */
export async function findUnansweredConversations(
  now: Date = new Date(),
  limit = 25,
): Promise<Array<{ id: string; agencyId: string }>> {
  const debounceCutoff = new Date(now.getTime() - getConfig().CHAT_DEBOUNCE_MS);
  const stale = staleTurnCutoff(now);

  const rows = await getDb()
    .select({ id: conversations.id, agencyId: conversations.agencyId })
    .from(conversations)
    .where(
      and(
        eq(conversations.status, "active"),
        or(isNull(conversations.processingSince), lt(conversations.processingSince, stale)),
        sql`exists (
          select 1 from messages m
          where m.conversation_id = ${conversations.id}
            and m.role = 'lead'
            and m.created_at < ${debounceCutoff}
            and m.created_at > coalesce((select max(m2.created_at) from messages m2
                  where m2.conversation_id = ${conversations.id} and m2.role in ('agent','broker')),
                to_timestamp(0)))`,
      ),
    )
    .orderBy(asc(conversations.lastLeadMessageAt))
    .limit(limit);

  return rows;
}

/** Hands the conversation back when a turn ends without committing. */
export async function releaseTurn(conversationId: string): Promise<void> {
  await getDb()
    .update(conversations)
    .set({ processingSince: null, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}
