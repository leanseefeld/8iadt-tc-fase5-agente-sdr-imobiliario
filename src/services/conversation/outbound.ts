import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../db/client.ts";
import { conversations, events as events_, messages } from "../../db/schema.ts";
import { MESSAGE_CHANNEL } from "../../core/notifier.ts";

/** A message the agent or a broker sends outside a turn (spec 005). */

export interface OutboundRecord {
  conversationId: string;
  /** `broker` when a person answered from the panel (spec 005). */
  role?: "agent" | "broker";
  /**
   * The broker who wrote it. Stored on the message so the transcript can name
   * the author (FR-029) and so a `broker` row is never mistaken for the agent's.
   */
  userId?: string;
  content: string;
  propertyIds?: string[];
  /** Hand the conversation to a person as part of this write (FR-028). */
  paused?: boolean;
  /** Spec 006 FR-015: a follow-up, marked so the dashboard and the metrics can tell. */
  isFollowUp?: boolean;
  now?: Date;
}

/**
 * One outbound message, written and announced — the persistence half of
 * `ChannelAdapter.send`.
 *
 * `commitTurn` is the path a *turn* takes and it writes far more than a
 * message; this is the path everything else takes, and spec 006's follow-up
 * will be its second caller. Both end the same way, on the same channel, so a
 * stream cannot tell which of them produced the bubble it just received — which
 * is the point of moving delivery off the request cycle.
 *
 * `repliesToMessageId` follows FR-044's rule here too: the last lead message
 * this reply leaves answered.
 */
export async function recordOutboundMessage(
  input: OutboundRecord,
): Promise<{ messageId: string; agencyId: string } | null> {
  const db = getDb();
  const now = input.now ?? new Date();

  const [conversation] = await db
    .select({
      id: conversations.id,
      agencyId: conversations.agencyId,
      leadId: conversations.leadId,
    })
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .limit(1);
  if (conversation === undefined) return null;

  const [lastLead] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, conversation.id), eq(messages.role, "lead")))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);

  return db.transaction(async (tx) => {
    const [written] = await tx
      .insert(messages)
      .values({
        conversationId: conversation.id,
        role: input.role ?? "agent",
        content: input.content,
        repliesToMessageId: lastLead?.id ?? null,
        metadata: {
          ...(input.propertyIds !== undefined && input.propertyIds.length > 0
            ? { propertyIds: input.propertyIds }
            : {}),
          ...(input.userId !== undefined ? { userId: input.userId } : {}),
          ...(input.isFollowUp === true ? { isFollowUp: true } : {}),
        },
        createdAt: now,
      })
      .returning({ id: messages.id });

    // A broker's reply is a turn of the conversation, so the summariser sees it
    // (spec 005 FR-008). Without this, a conversation a person handled would
    // keep the summary it had before they arrived.
    if (input.role === "broker") {
      await tx.insert(events_).values({
        agencyId: conversation.agencyId,
        leadId: conversation.leadId,
        conversationId: conversation.id,
        type: "conversation.turn",
        actorType: "user",
        actorUserId: input.userId ?? null,
        payload: { messageId: written.id },
        createdAt: now,
      });
    }

    await tx
      .update(conversations)
      .set({
        lastAgentMessageAt: now,
        ...(input.paused === true ? { status: "paused" as const, heldByUserId: null } : {}),
        updatedAt: now,
      })
      .where(eq(conversations.id, conversation.id));

    await tx.execute(
      sql`select pg_notify(${MESSAGE_CHANNEL}, ${JSON.stringify({
        conversationId: conversation.id,
        agencyId: conversation.agencyId,
        messageId: written.id,
      })})`,
    );

    return { messageId: written.id, agencyId: conversation.agencyId };
  });
}
