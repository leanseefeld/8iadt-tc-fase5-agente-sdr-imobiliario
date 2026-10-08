import type { Intent, Slots } from "../../domain/slots.ts";

/** The shapes a turn reads and writes. No queries. */

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


export type PropertyRef = { position: number } | { code: string };

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
