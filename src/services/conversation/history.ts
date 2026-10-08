import { and, asc, desc, eq, gt, inArray, ne, or } from "drizzle-orm";
import { getDb } from "../../db/client.ts";
import { agencies, conversations, leads, messages } from "../../db/schema.ts";
import type { Channel, ConversationStatus, TurnMessage } from "./types.ts";
import { toTurnMessage } from "./load.ts";

/** The reads the chat widget needs: the transcript and what came after an id. */

export interface ChatHistory {
  conversationId: string;
  agencyId: string;
  status: ConversationStatus;
  consented: boolean;
  messages: TurnMessage[];
}

/**
 * The whole transcript for one widget session — `contracts/chat-api.md` §3, and
 * the L14 continuity claim of SC-005 in one query.
 *
 * Deliberately not `loadTurn`: that read is bounded to `MODEL_HISTORY_WINDOW`
 * because it feeds a prompt, and a lead returning after a week must see more
 * than the model does. `null` for a session that has never written — a first
 * visit is not an error, and a read never creates a lead.
 */
export async function loadChatHistory(ref: {
  agencySlug: string;
  externalId: string;
  channel?: Channel;
  limit?: number;
}): Promise<ChatHistory | null> {
  const db = getDb();

  const [row] = await db
    .select({
      conversationId: conversations.id,
      agencyId: conversations.agencyId,
      status: conversations.status,
      consentAt: leads.consentAt,
    })
    .from(conversations)
    .innerJoin(agencies, eq(agencies.id, conversations.agencyId))
    .innerJoin(
      leads,
      and(eq(leads.id, conversations.leadId), eq(leads.agencyId, conversations.agencyId)),
    )
    .where(
      and(
        eq(agencies.slug, ref.agencySlug),
        eq(leads.externalId, ref.externalId),
        eq(leads.channel, ref.channel ?? "web"),
      ),
    )
    .orderBy(desc(conversations.createdAt))
    .limit(1);

  if (row === undefined) return null;

  const transcript = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, row.conversationId), ne(messages.role, "system")))
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(ref.limit ?? 200);

  return {
    conversationId: row.conversationId,
    agencyId: row.agencyId,
    status: row.status,
    consented: row.consentAt !== null,
    messages: transcript.map(toTurnMessage),
  };
}

/**
 * FR-048's replay: everything written to this conversation after the last event
 * the client saw. The `Last-Event-ID` is a message id, so the cursor is that
 * row's own timestamp — ordering by `(createdAt, id)` exactly as every other
 * read here does, so "after" means the same thing on both sides of a reconnect.
 *
 * An id the client invented, or one from a conversation that is not this one,
 * finds no cursor row and replays nothing rather than replaying everything.
 */
export async function readMessagesAfter(
  conversationId: string,
  lastEventId: string,
): Promise<TurnMessage[]> {
  const db = getDb();

  const [cursor] = await db
    .select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.id, lastEventId)))
    .limit(1);
  if (cursor === undefined) return [];

  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        ne(messages.role, "system"),
        or(
          gt(messages.createdAt, cursor.createdAt),
          and(eq(messages.createdAt, cursor.createdAt), gt(messages.id, cursor.id)),
        ),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(50);

  return rows.map(toTurnMessage);
}

/** Messages by id, scoped to one conversation — the SSE stream's re-read (FR-047). */
export async function readMessages(
  conversationId: string,
  messageIds: string[],
): Promise<TurnMessage[]> {
  if (messageIds.length === 0) return [];
  const rows = await getDb()
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), inArray(messages.id, messageIds)))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  return rows.map(toTurnMessage);
}
