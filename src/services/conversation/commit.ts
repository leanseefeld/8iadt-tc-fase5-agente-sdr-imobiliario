import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../db/client.ts";
import { conversations, events as events_, leads, messages } from "../../db/schema.ts";
import type { Intent, SlotKey, Slots } from "../../domain/slots.ts";
import type { HandoffReason } from "../../domain/handoff.ts";
import { recordToolSpans } from "../../core/langfuse.ts";
import { scheduleFollowup } from "../followup.ts";
import { maskPII } from "../../core/security.ts";
import { MESSAGE_CHANNEL } from "../../core/notifier.ts";
import type { CommittedToolCall, ConversationStatus, LeadStatus, LoadedTurn, SchedulingRecord } from "./types.ts";

/** The commit: everything a turn produced, in one transaction (FR-033). */

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

export interface PendingEvent {
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
