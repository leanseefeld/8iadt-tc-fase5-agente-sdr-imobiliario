import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { agencies, appointments, conversations, events as events_, leads, messages, properties, users } from "../db/schema.ts";
import { getConfig } from "../core/config.ts";
import { EMPTY_SLOTS, slotsSchema, type Intent, type SlotKey, type Slots } from "../domain/slots.ts";
import type { HandoffReason } from "../domain/handoff.ts";
import { recordToolSpans } from "../core/langfuse.ts";
import { cancelFollowup, scheduleFollowup } from "./followup.ts";
import { maskPII, maskText } from "../core/security.ts";
import { MESSAGE_CHANNEL } from "../core/notifier.ts";

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

/**
 * A conversation changed hands. Spec 005 writes these; the turn reads them so
 * the agent knows a person spoke in the middle of its own transcript.
 */
export interface Handover {
  kind: "assumed" | "returned";
  /** The broker's first name — what the agent may say to the lead. */
  name: string;
  at: Date;
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
  /**
   * Takeovers and hand-backs inside the history window, oldest first, plus the
   * name of whoever wrote each `broker` message. Empty for the overwhelming
   * majority of conversations, which no person ever touched.
   */
  handovers: Handover[];
  /** Broker user id → first name, for labelling their messages in the prompt. */
  brokerNames: Record<string, string>;
  /**
   * An offer to meet was **ever** made here (an `appointment.proposed` event).
   * Stays true after a booking or a decline: it is what keeps the agent from
   * offering again on its own — see `offerOutstanding`.
   */
  appointmentProposed: boolean;
  /**
   * A proposal is open **right now**: an appointment row still `proposed`.
   * What a decline or a pick can act on. False once it is booked, declined or
   * replaced — reading the event instead took "não vou mais poder" after a
   * booking for a decline, and told the lead "sem problema" with the visit
   * still confirmed.
   */
  proposalOpen: boolean;
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

/** FR-017 — an offer to meet is already outstanding. No query of its own. */
export function offerOutstanding(turn: LoadedTurn): boolean {
  if (turn.appointmentProposed) return true;
  // The offer stays outstanding for the rest of the loaded history, not only
  // for the single turn after it. The last agent message is often an unrelated
  // reply; the offer is whichever earlier message recorded one.
  return turn.history.some((message) => {
    if (message.role !== "agent") return false;
    return message.metadata.meeting === "viewing" || message.metadata.meeting === "call";
  });
}

/** FR-009 — the previous agent turn was a reconfirmation. No query of its own. */
/**
 * FR-033 — how many properties the most recent search matched, or `null` when
 * there was none. Read from the last agent message that recorded a
 * `searchProperties` call, so a later turn can answer "nenhum imóvel?" without
 * searching again. A search made under another intent does not describe this one,
 * so an intent that never searches (`investment`, `undefined`) gets `null`.
 */
export function lastSearchOutcome(
  turn: LoadedTurn,
  intent: Intent = turn.lead.intent,
): { count: number } | null {
  if (intent !== "purchase" && intent !== "rental") return null;
  const last = [...turn.history].reverse().find(
    (message) =>
      message.role === "agent" &&
      Array.isArray(message.metadata.toolCalls) &&
      (message.metadata.toolCalls as { name?: unknown }[]).some(
        (call) => call.name === "searchProperties",
      ),
  );
  if (last === undefined) return null;
  const ids = last.metadata.propertyIds;
  return { count: Array.isArray(ids) ? ids.length : 0 };
}

/** FR-005: the times the latest options message offered, in the order the lead saw them. */
export function lastOfferedOptions(turn: LoadedTurn): Date[] {
  const carrier = [...turn.history]
    .reverse()
    .find((message) => message.role === "agent" && Array.isArray(message.metadata.meetingOptions));
  if (carrier === undefined) return [];
  return (carrier.metadata.meetingOptions as unknown[])
    .filter((value): value is string => typeof value === "string")
    .map((value) => new Date(value));
}

/** The kind of meeting the latest options message offered, if one did. */
export function lastOfferedType(turn: LoadedTurn): "viewing" | "call" | null {
  const carrier = [...turn.history]
    .reverse()
    .find((message) => message.role === "agent" && Array.isArray(message.metadata.meetingOptions));
  const kind = carrier?.metadata.meeting;
  return kind === "viewing" || kind === "call" ? kind : null;
}

/**
 * Spec 009: what the **last** agent reply left pending — a cancel to confirm, a
 * choice between meetings, a rebook offer. Only the reply just before counts:
 * a lead who talks about something else has moved on, and nothing is carried
 * over from further back.
 */
export function pendingChange(
  turn: LoadedTurn,
): Pick<SchedulingRecord, "pendingCancel" | "pendingChoice" | "rebook" | "closing" | "humanOffer"> {
  const last = [...turn.history].reverse().find((message) => message.role === "agent");
  const metadata = last?.metadata ?? {};
  const choice = metadata.pendingChoice as { change?: unknown; ids?: unknown } | undefined;
  const rebook = metadata.rebook as SchedulingRecord["rebook"] | undefined;
  const offer = metadata.humanOffer as { about?: unknown } | undefined;
  return {
    ...(typeof metadata.pendingCancel === "string" ? { pendingCancel: metadata.pendingCancel } : {}),
    ...(choice !== undefined &&
    (choice.change === "cancel" || choice.change === "reschedule") &&
    Array.isArray(choice.ids)
      ? { pendingChoice: { change: choice.change, ids: choice.ids.filter((id): id is string => typeof id === "string") } }
      : {}),
    ...(rebook !== undefined && (rebook.type === "viewing" || rebook.type === "call") ? { rebook } : {}),
    ...(metadata.closing === true ? { closing: true as const } : {}),
    ...(offer !== undefined && typeof offer.about === "string" ? { humanOffer: { about: offer.about } } : {}),
  };
}

/** Spec 009: the appointment the latest options move, when they were offered for a reschedule. */
export function lastReschedulingId(turn: LoadedTurn): string | null {
  const carrier = [...turn.history]
    .reverse()
    .find((message) => message.role === "agent" && Array.isArray(message.metadata.meetingOptions));
  const id = carrier?.metadata.reschedulingId;
  return typeof id === "string" ? id : null;
}

/** FR-004b: the most recent property the lead pointed at, if any. */
export function latestInterestedProperty(turn: LoadedTurn): { id: string; code: string } | null {
  const carrier = [...turn.history]
    .reverse()
    .find((message) => message.role === "agent" && typeof message.metadata.interestedProperty === "object");
  const value = carrier?.metadata.interestedProperty as { id?: unknown; code?: unknown } | undefined;
  return typeof value?.id === "string" && typeof value.code === "string" ? { id: value.id, code: value.code } : null;
}

export type PropertyRef = { position: number } | { code: string };

/**
 * FR-004b: resolve "o segundo" or "VMA-0005" to a property — **only** among the
 * properties already shown in this conversation, never the catalog at large.
 * A position counts in the latest set of cards; a code may be any card shown so
 * far. Anything else is `null`: ignored, never guessed.
 */
export async function resolvePropertyRef(
  turn: LoadedTurn,
  ref: PropertyRef,
): Promise<{ id: string; code: string } | null> {
  const withCards = turn.history.filter(
    (message) => message.role === "agent" && Array.isArray(message.metadata.propertyIds),
  );
  const shown = withCards.flatMap((message) => message.metadata.propertyIds as string[]);
  if (shown.length === 0) return null;

  const db = getDb();
  if ("position" in ref) {
    const latest = withCards.at(-1)?.metadata.propertyIds as string[];
    const id = latest[ref.position - 1];
    if (id === undefined) return null;
    const [row] = await db.select({ id: properties.id, code: properties.code }).from(properties).where(eq(properties.id, id));
    return row ?? null;
  }
  const [row] = await db
    .select({ id: properties.id, code: properties.code })
    .from(properties)
    .where(
      and(
        eq(properties.agencyId, turn.agency.id),
        sql`upper(${properties.code}) = ${ref.code.toUpperCase()}`,
        inArray(properties.id, shown),
      ),
    );
  return row ?? null;
}

export function lastTurnWasReconfirmation(turn: LoadedTurn): boolean {
  const lastAgent = [...turn.history].reverse().find((message) => message.role === "agent");
  return lastAgent?.metadata.reconfirmation === true;
}

/** "Ana Ribeiro" → "Ana". The lead is being introduced to a person, not a record. */
function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? full;
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

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

export interface InboundLeadMessage {
  agencySlug: string;
  channel?: Channel;
  /** The lead's identity on the channel — the widget's session id. */
  externalId: string;
  /** Client-generated; the idempotency key of FR-035. */
  clientMessageId: string;
  text: string;
  /** Sent once, on the message where the lead taps "Aceito". */
  consent?: boolean;
  receivedAt?: Date;
}

export type InboundRejection = "consent" | "budget" | "tooLong";

export type InboundResult =
  | { status: "unknownAgency" }
  | { status: "rejected"; reason: InboundRejection }
  /** `duplicate` means the same `clientMessageId` arrived before — nothing was written. */
  | {
      status: "stored" | "duplicate" | "consented";
      agencyId: string;
      leadId: string;
      conversationId: string;
      conversationStatus: ConversationStatus;
      messageId: string | null;
      consented: boolean;
    };

/**
 * Stores one inbound lead message, creating the lead and the conversation on
 * first contact — which is why opening the widget and leaving creates nothing.
 *
 * Three things are refused before anything is written, each costing no model
 * call and persisting no turn (FR-019, FR-032): a message longer than
 * `CHAT_MAX_MESSAGE_CHARS`, a message sent before consent is recorded, and a
 * session over `CHAT_MESSAGE_BUDGET` inside its window. The caller answers each
 * with the fixed pt-BR template of `contracts/chat-api.md` §2.
 *
 * Idempotency is the unique index of `data-model.md` §5, not a read-then-write
 * check: the second arrival of a `clientMessageId` conflicts, inserts nothing and
 * is reported as `duplicate`, so no second lead message and no second turn
 * (FR-035). `on conflict do nothing` rather than catch-and-continue, because a
 * raised unique violation aborts the whole transaction in Postgres and would
 * take the lead and the conversation created above down with it.
 */
export async function recordLeadMessage(inbound: InboundLeadMessage): Promise<InboundResult> {
  const db = getDb();
  const config = getConfig();
  const channel = inbound.channel ?? "web";
  const now = inbound.receivedAt ?? new Date();
  const text = inbound.text.trim();

  if (text.length > config.CHAT_MAX_MESSAGE_CHARS) return { status: "rejected", reason: "tooLong" };

  const [agency] = await db
    .select({ id: agencies.id })
    .from(agencies)
    .where(eq(agencies.slug, inbound.agencySlug))
    .limit(1);
  if (agency === undefined) return { status: "unknownAgency" };

  const existing = await loadTurn({ agencySlug: inbound.agencySlug, externalId: inbound.externalId, channel });
  const consented = existing?.lead.consentAt != null || inbound.consent === true;

  // Nothing at all is created for text typed before the "Aceito" button.
  if (!consented) return { status: "rejected", reason: "consent" };

  if (existing !== null && text !== "" && existing.budgetUsed >= config.CHAT_MESSAGE_BUDGET) {
    return { status: "rejected", reason: "budget" };
  }

  return db.transaction(async (tx) => {
    let leadId = existing?.lead.id;
    let conversationId = existing?.conversation.id;
    let conversationStatus: ConversationStatus = existing?.conversation.status ?? "active";
    const newEvents: PendingEvent[] = [];

    if (leadId === undefined || conversationId === undefined) {
      // Two tabs opening at once both read "no conversation" and both try to
      // create the lead. `on conflict do nothing` lets the loser re-read the
      // winner's row instead of aborting its whole transaction on the
      // `(agency, channel, externalId)` unique index.
      const [created] = await tx
        .insert(leads)
        .values({
          agencyId: agency.id,
          channel,
          externalId: inbound.externalId,
          consentAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: leads.id, consentAt: leads.consentAt });

      if (created === undefined) {
        const [found] = await tx
          .select({ id: leads.id, consentAt: leads.consentAt })
          .from(leads)
          .where(
            and(
              eq(leads.agencyId, agency.id),
              eq(leads.channel, channel),
              eq(leads.externalId, inbound.externalId),
            ),
          )
          .limit(1);
        if (found === undefined) throw new Error("lead vanished between insert and read");
        leadId = found.id;
        if (found.consentAt === null) {
          await tx.update(leads).set({ consentAt: now, updatedAt: now }).where(eq(leads.id, leadId));
          newEvents.push({ type: "lead.consented", payload: {} });
        }
      } else {
        leadId = created.id;
        newEvents.push({ type: "lead.created", payload: { channel } });
        newEvents.push({ type: "lead.consented", payload: {} });
      }

      const [openConversation] = await tx
        .select({ id: conversations.id, status: conversations.status })
        .from(conversations)
        .where(and(eq(conversations.leadId, leadId), eq(conversations.agencyId, agency.id)))
        .orderBy(desc(conversations.createdAt))
        .limit(1);

      if (openConversation === undefined) {
        const [conversation] = await tx
          .insert(conversations)
          .values({ agencyId: agency.id, leadId, channel, createdAt: now, updatedAt: now })
          .returning({ id: conversations.id });
        conversationId = conversation.id;
        conversationStatus = "active";
      } else {
        conversationId = openConversation.id;
        conversationStatus = openConversation.status;
      }
    } else if (existing?.lead.consentAt == null) {
      await tx
        .update(leads)
        .set({ consentAt: now, updatedAt: now })
        .where(and(eq(leads.id, leadId), eq(leads.agencyId, agency.id)));
      newEvents.push({ type: "lead.consented", payload: {} });
    }

    let messageId: string | null = null;

    if (text !== "") {
      const stored = await tx
        .insert(messages)
        .values({
          conversationId,
          role: "lead",
          content: text,
          metadata: { clientMessageId: inbound.clientMessageId },
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: messages.id });
      messageId = stored[0]?.id ?? null;
    }

    const duplicate = text !== "" && messageId === null;

    if (messageId !== null) {
      await tx
        .update(conversations)
        .set({ lastLeadMessageAt: now, updatedAt: now })
        .where(and(eq(conversations.id, conversationId), eq(conversations.agencyId, agency.id)));
      // Spec 006 FR-010: the lead wrote, so nothing is owed to them any more.
      await cancelFollowup(tx, conversationId, now);
    }

    if (newEvents.length > 0) {
      await tx.insert(events_).values(
        newEvents.map((event) => ({
          agencyId: agency.id,
          leadId,
          conversationId,
          type: event.type,
          actorType: "agent" as const,
          actorUserId: null,
          traceId: null,
          payload: maskPII(event.payload),
          createdAt: now,
        })),
      );
    }

    return {
      status: duplicate ? ("duplicate" as const) : text === "" ? ("consented" as const) : ("stored" as const),
      agencyId: agency.id,
      leadId,
      conversationId,
      conversationStatus,
      messageId,
      consented: true,
    };
  });
}

// ---------------------------------------------------------------------------
// The commit
// ---------------------------------------------------------------------------

/**
 * The `LISTEN/NOTIFY` channel every persisted message announces itself on
 * (`visao-geral.md` §8). The payload carries ids only — the replica that wakes
 * re-reads the row scoped by agency and conversation before writing it to a
 * stream, because the notification is a doorbell, not a delivery.
 *
 * Declared by `core/notifier.ts`, which is the side that listens; re-exported
 * here so the writer and the reader can never drift onto two channel names.
 */
export { MESSAGE_CHANNEL };

export interface CommittedToolCall {
  name: string;
  /** Masked before it is written — a tool argument can carry a name or a phone. */
  arguments: unknown;
  /**
   * What the tool returned, for its span's output only. **Not persisted**: the
   * message metadata keeps carrying `{ name, arguments }` alone, because a
   * transcript row must not become a copy of the catalog
   * (`contracts/chat-api.md` §5). A trace, on the other hand, is exactly where
   * "what did the agent put on the screen?" should be answerable.
   */
  result?: unknown;
  /** Set when the action loop already recorded this call's span. */
  stepIndex?: number;
  refused?: boolean;
}

export interface CommitTurnInput {
  turn: LoadedTurn;
  /** The reply, exactly as the guards approved it. */
  reply: string;
  intent: Intent;
  slots: Slots;
  /** Slots that went empty → filled this turn, in script order. */
  filled: SlotKey[];
  /** Slots that went value → different value. Recorded with the same event as a fill. */
  revised?: SlotKey[];
  score: number;
  qualified: boolean;
  fallbackStreak: number;
  handoffReason?: HandoffReason | null;
  optedOut?: boolean;
  /** Cards shown with this reply, in order (FR-026). */
  propertyIds?: string[];
  /** Which reply guard rewrote the reply, when one did. */
  guard?: string | null;
  /** Set when this turn offered a meeting, so the next turn can see it. */
  meeting?: "viewing" | "call" | null;
  /** Set when this turn was a reconfirmation (FR-009). */
  reconfirmation?: boolean;
  /** Spec 006: what this turn did about a meeting, for later turns and the widget. */
  scheduling?: SchedulingRecord;
  /**
   * Spec 006 FR-009: the reply leaves the lead something to answer — the
   * script's next question, or options awaiting a pick. The follow-up clock
   * starts when this is true; its guards decide whether it may.
   */
  awaitingLead?: boolean;
  toolCalls?: CommittedToolCall[];
  traceId?: string | null;
  now?: Date;
}

/**
 * Spec 006's facts about a meeting, stored on the agent message that carried
 * them. Later turns derive everything from these — never from memory held
 * between turns (ADR 22).
 */
export interface SchedulingRecord {
  /** The times this reply offered, ISO, in the order numbered (FR-005 reads them back). */
  options?: string[];
  /** The lead declined the open proposal this turn (FR-005a). */
  declined?: boolean;
  /** The property the lead pointed at this turn (FR-004b). */
  interestedProperty?: { id: string; code: string };
  /** The meeting booked this turn; the widget renders it as a card (FR-006). */
  booking?: { appointmentId: string; scheduledAt: string; type: "viewing" | "call"; propertyCode: string | null };
  /** Spec 009: "quer mesmo cancelar?" was asked about this appointment; the next yes cancels it. */
  pendingCancel?: string;
  /** Spec 009: "qual delas?" was asked; the next message picks among these, for this change. */
  pendingChoice?: { change: "cancel" | "reschedule"; ids: string[] };
  /** Spec 009: the options this reply offered move this confirmed appointment, not a proposal. */
  reschedulingId?: string;
  /** Spec 009: a meeting was cancelled and "quer marcar outro dia?" asked; a yes offers these again. */
  rebook?: { type: "viewing" | "call"; propertyId: string | null; propertyCode: string | null };
  /** Spec 009: this reply closed the conversation for now; the next message is a return. */
  closing?: true;
  /**
   * Spec 015: this reply offered to have someone from the team check `about`,
   * something the agent can't resolve. The next yes is a handoff, a no a close.
   */
  humanOffer?: { about: string };
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

  // The `tool.*` spans of contracts/observability.md §2, from the same list this
  // function is about to persist — one place for every commit path, and the
  // only place that knows the full set, because this agent invokes its tools
  // from code and the AI SDK never sees them execute. A no-op without Langfuse.
  recordToolSpans(
    (input.toolCalls ?? [])
      // Loop steps are spanned inside `act()` with `step.index`. Spanning them
      // again here would double the children under `model.act`.
      .filter((call) => call.stepIndex === undefined)
      .map((call) => ({
        name: call.name,
        attributes: { arguments: call.arguments },
        ...(call.result === undefined ? {} : { result: call.result }),
      })),
  );

  // Spec 006: a booking moved the lead to `scheduled` during this turn, in its
  // own transaction, with its own event. The stage loaded at the start of the
  // turn is stale by then; writing it back would undo the booking's.
  const stageNow =
    input.scheduling?.booking === undefined
      ? turn.lead.status
      : ((
          await getDb().select({ status: leads.status }).from(leads).where(eq(leads.id, turn.lead.id))
        )[0]?.status as LeadStatus | undefined) ?? turn.lead.status;
  const leadStatus = nextLeadStatus(stageNow, input.intent, input.qualified);
  const conversationStatus: ConversationStatus =
    input.optedOut === true ? "closed" : input.handoffReason != null ? "paused" : turn.conversation.status;

  const contact = splitContact(input.slots.contact);
  const events: PendingEvent[] = [];

  if (turn.lead.intent === "undefined" && input.intent !== "undefined") {
    events.push({ type: "intent.identified", payload: { intent: input.intent } });
  }
  // A revision writes the same `slot.filled` row a first fill does (FR-029).
  for (const slot of [...input.filled, ...(input.revised ?? [])]) {
    const value = input.slots[slot];
    events.push({
      type: "slot.filled",
      payload: {
        slot,
        // Through `maskPII` under the slot's own key, not `maskText`: the rule is
        // key-aware, and a bare `Camila` is not free text with a phone in it —
        // `maskText` left it whole and the name went to `events` unmasked.
        value:
          slot === "name" || slot === "contact"
            ? (maskPII({ [slot]: value }) as Record<string, unknown>)[slot]
            : value,
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
  if (leadStatus !== stageNow) {
    events.push({
      type: "lead.status_changed",
      payload: { from: stageNow, to: leadStatus },
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
        metadata: {
          ...(input.propertyIds !== undefined && input.propertyIds.length > 0
            ? { propertyIds: input.propertyIds }
            : {}),
          ...(input.guard != null ? { guard: input.guard } : {}),
          ...(input.meeting != null ? { meeting: input.meeting } : {}),
          ...(input.reconfirmation === true ? { reconfirmation: true } : {}),
          ...(input.scheduling?.options !== undefined ? { meetingOptions: input.scheduling.options } : {}),
          ...(input.scheduling?.declined === true ? { offerDeclined: true } : {}),
          ...(input.scheduling?.interestedProperty !== undefined
            ? { interestedProperty: input.scheduling.interestedProperty }
            : {}),
          ...(input.scheduling?.booking !== undefined ? { booking: input.scheduling.booking } : {}),
          ...(input.scheduling?.pendingCancel !== undefined ? { pendingCancel: input.scheduling.pendingCancel } : {}),
          ...(input.scheduling?.pendingChoice !== undefined ? { pendingChoice: input.scheduling.pendingChoice } : {}),
          ...(input.scheduling?.reschedulingId !== undefined ? { reschedulingId: input.scheduling.reschedulingId } : {}),
          ...(input.scheduling?.rebook !== undefined ? { rebook: input.scheduling.rebook } : {}),
          ...(input.scheduling?.closing === true ? { closing: true } : {}),
          ...(input.scheduling?.humanOffer !== undefined ? { humanOffer: input.scheduling.humanOffer } : {}),
          // Masked one level down, not as a whole: `maskPII` is key-aware and a
          // tool's `name` is the tool's, not a person's — masking the object
          // would write `u***` where `updateSlots` belongs.
          ...(input.toolCalls !== undefined && input.toolCalls.length > 0
            ? {
                toolCalls: input.toolCalls.map((call) => ({
                  name: call.name,
                  arguments: maskPII(call.arguments),
                })),
              }
            : {}),
        },
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

    if (input.awaitingLead === true) {
      await scheduleFollowup(tx, turn.conversation.id, now);
    }

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

// ---------------------------------------------------------------------------
// Reads the widget needs
// ---------------------------------------------------------------------------

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
