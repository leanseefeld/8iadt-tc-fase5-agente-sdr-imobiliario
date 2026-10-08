import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "../../db/client.ts";
import { agencies, appointments, conversations, events as events_, leads, messages, users } from "../../db/schema.ts";
import { getConfig } from "../../core/config.ts";
import { EMPTY_SLOTS, slotsSchema, type Slots } from "../../domain/slots.ts";
import type { LoadedTurn, TurnMessage, TurnRef } from "./types.ts";

/** Loading a turn: one bounded read of everything a turn needs (FR-007). */

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

  const [recent, unanswered, budget, handoverRows, proposedRows, openRows] = await Promise.all([
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
    // The handover trail. Two event types, one index (`events_conversation_created_idx`),
    // and almost always zero rows — a conversation a person never touched pays
    // one cheap indexed lookup and nothing else.
    db
      .select({ type: events_.type, at: events_.createdAt, name: users.name, userId: users.id })
      .from(events_)
      .innerJoin(users, eq(users.id, events_.actorUserId))
      .where(
        and(
          eq(events_.conversationId, conversationId),
          inArray(events_.type, ["conversation.assumed", "conversation.returned"]),
        ),
      )
      .orderBy(asc(events_.createdAt)),
    // One indexed lookup, not a second round trip from the caller. Spec 006
    // starts writing this event; the flag is already here so that needs no
    // change in the orchestrator.
    db
      .select({ id: events_.id })
      .from(events_)
      .where(and(eq(events_.conversationId, conversationId), eq(events_.type, "appointment.proposed")))
      .limit(1),
    db
      .select({ id: appointments.id })
      .from(appointments)
      .where(and(eq(appointments.conversationId, conversationId), eq(appointments.status, "proposed")))
      .limit(1),
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
    handovers: handoverRows.map((row) => ({
      kind: row.type === "conversation.assumed" ? ("assumed" as const) : ("returned" as const),
      name: firstName(row.name),
      at: row.at,
    })),
    brokerNames: Object.fromEntries(
      handoverRows.map((row) => [row.userId, firstName(row.name)]),
    ),
    appointmentProposed: proposedRows.length > 0,
    proposalOpen: openRows.length > 0,
  };
}

/** "Ana Ribeiro" → "Ana". The lead is being introduced to a person, not a record. */
export function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? full;
}

export function toTurnMessage(row: typeof messages.$inferSelect): TurnMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    repliesToMessageId: row.repliesToMessageId,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}
