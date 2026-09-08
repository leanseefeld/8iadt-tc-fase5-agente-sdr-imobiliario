import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { agencies, conversations, leads, messages } from "../db/schema.ts";
import { getConfig } from "../core/config.ts";
import { EMPTY_SLOTS, slotsSchema, type Intent, type Slots } from "../domain/slots.ts";

/**
 * The turn's one door to the database.
 *
 * `agent/` computes and phrases; this module reads what a turn needs and writes
 * what it produced, in a single transaction, so a failed turn leaves nothing
 * behind (FR-033). Constitution IV: nothing above `services/` imports `db/`.
 *
 * Every query is scoped by `agencyId` (ADR 10). `messages` carries no
 * `agencyId` column of its own — it is scoped transitively, through the
 * conversation this module resolved under an agency in the first place.
 */

export type Channel = "web" | "telegram";
export type MessageRole = "lead" | "agent" | "broker" | "system";
export type ConversationStatus = "active" | "paused" | "closed";
export type LeadStatus =
  | "new"
  | "qualifying"
  | "qualified"
  | "scheduled"
  | "visited"
  | "won"
  | "lost";

export interface TurnMessage {
  id: string;
  role: MessageRole;
  content: string;
  repliesToMessageId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface TurnLead {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  channel: Channel;
  externalId: string;
  intent: Intent;
  status: LeadStatus;
  score: number;
  consentAt: Date | null;
  doNotContact: boolean;
}

export interface TurnConversation {
  id: string;
  status: ConversationStatus;
  heldByUserId: string | null;
  slots: Slots;
  fallbackStreak: number;
  processingSince: Date | null;
  lastLeadMessageAt: Date | null;
  lastAgentMessageAt: Date | null;
}

export interface LoadedTurn {
  agency: { id: string; slug: string };
  lead: TurnLead;
  conversation: TurnConversation;
  /** Oldest first, at most `MODEL_HISTORY_WINDOW` — everything the model sees. */
  history: TurnMessage[];
  /** Lead messages since the last agent or broker reply; this turn answers all of them. */
  unanswered: TurnMessage[];
  /** Lead messages inside the current `CHAT_BUDGET_WINDOW_MINUTES` window. */
  budgetUsed: number;
}

/** Either end of the turn: the route handler has a session, the worker has an id. */
export type TurnRef =
  | { conversationId: string }
  | { agencySlug: string; externalId: string; channel?: Channel };

/**
 * Stored slots are `jsonb` written by an older version of this code as much as
 * by this one, so they are parsed, not trusted. An unparsable slot falls back
 * to empty rather than failing the turn.
 */
export function readSlots(stored: unknown): Slots {
  const parsed = slotsSchema.safeParse({ ...EMPTY_SLOTS, ...(stored as object) });
  return parsed.success ? parsed.data : { ...EMPTY_SLOTS };
}

/**
 * Loads everything a turn needs and nothing it does not: the agency, the lead,
 * the active conversation, a bounded window of history (FR-007), the lead
 * messages still unanswered (FR-044) and the session's message count inside the
 * budget window (FR-032). Returns `null` when there is no conversation yet —
 * a read never creates one.
 */
export async function loadTurn(ref: TurnRef): Promise<LoadedTurn | null> {
  const db = getDb();
  const config = getConfig();

  const [row] = await ("conversationId" in ref
    ? db
        .select({ agency: agencies, lead: leads, conversation: conversations })
        .from(conversations)
        .innerJoin(agencies, eq(agencies.id, conversations.agencyId))
        .innerJoin(
          leads,
          and(eq(leads.id, conversations.leadId), eq(leads.agencyId, conversations.agencyId)),
        )
        .where(eq(conversations.id, ref.conversationId))
        .limit(1)
    : db
        .select({ agency: agencies, lead: leads, conversation: conversations })
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
        .limit(1));

  if (row === undefined) return null;

  const conversationId = row.conversation.id;
  const windowStart = new Date(Date.now() - config.CHAT_BUDGET_WINDOW_MINUTES * 60_000);

  const [recent, unanswered, budget] = await Promise.all([
    db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(config.MODEL_HISTORY_WINDOW),
    db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.role, "lead"),
          sql`${messages.createdAt} > coalesce((select max(m.created_at) from messages m
                where m.conversation_id = ${conversationId} and m.role in ('agent','broker')),
              to_timestamp(0))`,
        ),
      )
      .orderBy(asc(messages.createdAt), asc(messages.id)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.role, "lead"),
          gte(messages.createdAt, windowStart),
        ),
      ),
  ]);

  return {
    agency: { id: row.agency.id, slug: row.agency.slug },
    lead: {
      id: row.lead.id,
      name: row.lead.name,
      phone: row.lead.phone,
      email: row.lead.email,
      channel: row.lead.channel,
      externalId: row.lead.externalId,
      intent: row.lead.intent,
      status: row.lead.status,
      score: row.lead.score,
      consentAt: row.lead.consentAt,
      doNotContact: row.lead.doNotContact,
    },
    conversation: {
      id: conversationId,
      status: row.conversation.status,
      heldByUserId: row.conversation.heldByUserId,
      slots: readSlots(row.conversation.slots),
      fallbackStreak: row.conversation.fallbackStreak,
      processingSince: row.conversation.processingSince,
      lastLeadMessageAt: row.conversation.lastLeadMessageAt,
      lastAgentMessageAt: row.conversation.lastAgentMessageAt,
    },
    history: recent.reverse().map(toTurnMessage),
    unanswered: unanswered.map(toTurnMessage),
    budgetUsed: budget[0]?.count ?? 0,
  };
}

function toTurnMessage(row: typeof messages.$inferSelect): TurnMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    repliesToMessageId: row.repliesToMessageId,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
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
