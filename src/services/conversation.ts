import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { agencies, conversations, events as events_, leads, messages } from "../db/schema.ts";
import { getConfig } from "../core/config.ts";
import { EMPTY_SLOTS, slotsSchema, type Intent, type SlotKey, type Slots } from "../domain/slots.ts";
import type { HandoffReason } from "../domain/handoff.ts";
import { maskPII, maskText } from "../core/security.ts";

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

/** Hands the conversation back when a turn ends without committing. */
export async function releaseTurn(conversationId: string): Promise<void> {
  await getDb()
    .update(conversations)
    .set({ processingSince: null, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

// ---------------------------------------------------------------------------
// The commit
// ---------------------------------------------------------------------------

/**
 * The `LISTEN/NOTIFY` channel every persisted message announces itself on
 * (`visao-geral.md` §8). The payload carries ids only — the replica that wakes
 * re-reads the row scoped by agency and conversation before writing it to a
 * stream, because the notification is a doorbell, not a delivery.
 */
export const MESSAGE_CHANNEL = "conversation_message";

export interface CommittedToolCall {
  name: string;
  /** Masked before it is written — a tool argument can carry a name or a phone. */
  arguments: unknown;
}

export interface CommitTurnInput {
  turn: LoadedTurn;
  /** The reply, exactly as the guards approved it. */
  reply: string;
  intent: Intent;
  slots: Slots;
  /** Slots that went empty → filled this turn, in script order. */
  filled: SlotKey[];
  score: number;
  qualified: boolean;
  fallbackStreak: number;
  handoffReason?: HandoffReason | null;
  optedOut?: boolean;
  /** Cards shown with this reply, in order (FR-026). */
  propertyIds?: string[];
  /** Which reply guard rewrote the reply, when one did. */
  guard?: string | null;
  toolCalls?: CommittedToolCall[];
  traceId?: string | null;
  now?: Date;
}

export interface CommitTurnResult {
  messageId: string;
  repliesToMessageId: string | null;
  conversationStatus: ConversationStatus;
  leadStatus: LeadStatus;
  score: number;
  events: string[];
}

/** Forward-only, and the agent owns only the first three (ADR 19, §7). */
const AGENT_STAGES: LeadStatus[] = ["new", "qualifying", "qualified"];

function nextLeadStatus(current: LeadStatus, intent: Intent, qualified: boolean): LeadStatus {
  // Past `qualified` the broker and the agenda own the stage; never walk it back.
  if (!AGENT_STAGES.includes(current)) return current;
  if (qualified) return "qualified";
  if (intent !== "undefined") return "qualifying";
  return current;
}

/** The `contact` slot is "phone or e-mail" in one field; the lead has two columns. */
function splitContact(contact: string | null): { phone: string | null; email: string | null } {
  if (contact === null) return { phone: null, email: null };
  if (contact.includes("@")) return { phone: null, email: contact.trim() };
  const digits = contact.replace(/\D/g, "");
  return { phone: digits.length >= 10 ? contact.trim() : null, email: null };
}

interface PendingEvent {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Every state change a turn produced, in one transaction, after the reply is
 * complete (FR-033) — so a turn that dies half-way leaves the conversation
 * exactly as it found it, and the same lead message can simply be answered again.
 *
 * It also releases the claim and rings the `NOTIFY` doorbell, both of which have
 * to be part of the same commit or a crash between them would strand the turn.
 */
export async function commitTurn(input: CommitTurnInput): Promise<CommitTurnResult> {
  const { turn } = input;
  const now = input.now ?? new Date();
  const repliesToMessageId = turn.unanswered.at(-1)?.id ?? null;

  const leadStatus = nextLeadStatus(turn.lead.status, input.intent, input.qualified);
  const conversationStatus: ConversationStatus =
    input.optedOut === true ? "closed" : input.handoffReason != null ? "paused" : turn.conversation.status;

  const contact = splitContact(input.slots.contact);
  const events: PendingEvent[] = [];

  if (turn.lead.intent === "undefined" && input.intent !== "undefined") {
    events.push({ type: "intent.identified", payload: { intent: input.intent } });
  }
  for (const slot of input.filled) {
    const value = input.slots[slot];
    events.push({
      type: "slot.filled",
      payload: {
        slot,
        value: slot === "name" || slot === "contact" ? maskText(String(value)) : value,
      },
    });
  }
  if (input.propertyIds !== undefined && input.propertyIds.length > 0) {
    events.push({ type: "properties.suggested", payload: { propertyIds: input.propertyIds } });
  }
  if (input.handoffReason != null) {
    events.push({ type: "handoff.requested", payload: { reason: input.handoffReason } });
  }
  if (input.optedOut === true) {
    events.push({ type: "lead.opted_out", payload: {} });
  }
  if (leadStatus !== turn.lead.status) {
    events.push({
      type: "lead.status_changed",
      payload: { from: turn.lead.status, to: leadStatus },
    });
  }

  const db = getDb();

  return db.transaction(async (tx) => {
    const [agentMessage] = await tx
      .insert(messages)
      .values({
        conversationId: turn.conversation.id,
        role: "agent",
        content: input.reply,
        repliesToMessageId,
        metadata: maskPII({
          ...(input.propertyIds !== undefined && input.propertyIds.length > 0
            ? { propertyIds: input.propertyIds }
            : {}),
          ...(input.guard != null ? { guard: input.guard } : {}),
          ...(input.toolCalls !== undefined && input.toolCalls.length > 0
            ? { toolCalls: input.toolCalls }
            : {}),
        }) as Record<string, unknown>,
        createdAt: now,
      })
      .returning({ id: messages.id });

    // `conversation.turn` names the message it produced, which is what the
    // summariser (005) consumes.
    events.push({ type: "conversation.turn", payload: { messageId: agentMessage.id } });

    await tx
      .update(conversations)
      .set({
        slots: input.slots as unknown as Record<string, unknown>,
        status: conversationStatus,
        fallbackStreak: input.fallbackStreak,
        lastAgentMessageAt: now,
        processingSince: null,
        updatedAt: now,
      })
      .where(
        and(eq(conversations.id, turn.conversation.id), eq(conversations.agencyId, turn.agency.id)),
      );

    await tx
      .update(leads)
      .set({
        intent: input.intent,
        status: leadStatus,
        score: input.score,
        // Never nulled here: a filled slot cannot go back to empty (merge rule 1),
        // so an absent slot means "unchanged", not "cleared".
        ...(input.slots.name !== null ? { name: input.slots.name } : {}),
        ...(contact.phone !== null ? { phone: contact.phone } : {}),
        ...(contact.email !== null ? { email: contact.email } : {}),
        ...(input.optedOut === true ? { doNotContact: true } : {}),
        updatedAt: now,
      })
      .where(and(eq(leads.id, turn.lead.id), eq(leads.agencyId, turn.agency.id)));

    await tx.insert(events_).values(
      events.map((event) => ({
        agencyId: turn.agency.id,
        leadId: turn.lead.id,
        conversationId: turn.conversation.id,
        type: event.type,
        // FR-050: this slice's events are all the agent's, and carry the turn's trace.
        actorType: "agent" as const,
        actorUserId: null,
        traceId: input.traceId ?? null,
        payload: maskPII(event.payload),
        createdAt: now,
      })),
    );

    await tx.execute(
      sql`select pg_notify(${MESSAGE_CHANNEL}, ${JSON.stringify({
        conversationId: turn.conversation.id,
        agencyId: turn.agency.id,
        messageId: agentMessage.id,
      })})`,
    );

    return {
      messageId: agentMessage.id,
      repliesToMessageId,
      conversationStatus,
      leadStatus,
      score: input.score,
      events: events.map((event) => event.type),
    };
  });
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
