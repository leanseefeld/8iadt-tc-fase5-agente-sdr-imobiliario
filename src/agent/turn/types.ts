import type { HandoffReason } from "../../domain/handoff.ts";
import type { Intent, Question, SlotKey, Slots } from "../../domain/slots.ts";
import type { LeadStatus } from "../../services/conversation.ts";
import type { ReplySink } from "./sink.ts";

export type SkipReason =
  | "noConversation"
  | "notActive"
  | "nothingUnanswered"
  | "preConsent"
  | "alreadyRunning";

/**
 * `contracts/observability.md` §1: one value, always set. `budget_exceeded` and
 * `replayed` are the two the turn itself never produces — the budget is refused
 * in the route handler before a turn starts (FR-032), and a replay never runs
 * one (FR-042).
 */
export type TurnOutcomeName = "replied" | "fallback" | "handoff" | "meeting_proposed" | "opted_out";

export type TurnResult =
  | { status: "skipped"; reason: SkipReason; reply?: string }
  | {
      status: "committed";
      conversationId: string;
      messageId: string;
      repliesToMessageId: string | null;
      reply: string;
      intent: Intent;
      slots: Slots;
      filled: SlotKey[];
      score: number;
      qualified: boolean;
      question: Question | null;
      guard: string | null;
      handoffReason: HandoffReason | null;
      meeting: "viewing" | "call" | null;
      /** The catalog codes this turn put on the screen, in order (SC-004). */
      propertyCodes: string[];
      events: string[];
      /** How this turn ended, and the stage it left the lead in (contract §1). */
      outcome: TurnOutcomeName;
      stage: LeadStatus;
    };

export interface RunTurnOptions {
  conversationId: string;
  /** Approved sentences are written here as they clear the guards (FR-017). */
  sink?: ReplySink;
  now?: Date;
  /** The Langfuse trace of this turn, recorded on every event it writes (FR-050). */
  traceId?: string | null;
}

/** What every step of a running turn shares: where to write, and when it started. */
export interface RunContext extends RunTurnOptions {
  sink: ReplySink;
  now: Date;
  startedAt: number;
}
