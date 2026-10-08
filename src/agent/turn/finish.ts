import type { HandoffReason } from "../../domain/handoff.ts";
import type { Intent, Question, SlotKey, Slots } from "../../domain/slots.ts";
import {
  commitTurn,
  type CommittedToolCall,
  type LoadedTurn,
  type SchedulingRecord,
} from "../../services/conversation.ts";
import { pauseBeforeFirstChunk } from "./sink.ts";
import type { RunContext, TurnOutcomeName, TurnResult } from "./types.ts";

export interface FinishInput {
  turn: LoadedTurn;
  context: RunContext;
  reply: string;
  /** True for a reply this code wrote: it still has to be paused for and sent. */
  speak?: boolean;
  intent: Intent;
  slots: Slots;
  filled: SlotKey[];
  score: number;
  qualified: boolean;
  fallbackStreak: number;
  question: Question | null;
  /** Slots that went value → different value this turn. Same event as a first fill. */
  revised?: SlotKey[];
  outcome: TurnOutcomeName;
  guard?: string | null;
  handoffReason?: HandoffReason | null;
  meeting?: "viewing" | "call" | null;
  /** This turn restated dependants and asked the lead to confirm them. */
  reconfirmation?: boolean;
  /** Spec 006: what this turn did about a meeting. */
  scheduling?: SchedulingRecord;
  optedOut?: boolean;
  toolCalls?: CommittedToolCall[];
  propertyIds?: string[];
  propertyCodes?: string[];
}

/**
 * The one way a turn ends: commit, close the sink, report.
 *
 * Four paths reach here — a refusal, an opt-out, a handoff and the ordinary
 * phrased reply — and each used to build the transaction and the `TurnResult`
 * by hand. A hundred and fifty lines of four copies that had already drifted,
 * and where a field added to one would have been forgotten in the other three.
 * What actually differs between them is data, so it is arguments now.
 *
 * `speak` is the one real distinction left: a written reply has not been sent
 * yet and still owes the lead FR-017's pause, while a phrased one streamed
 * sentence by sentence as the guards cleared it.
 */
export async function finish(input: FinishInput): Promise<TurnResult> {
  const { turn, context } = input;

  if (input.speak === true) {
    await pauseBeforeFirstChunk(context.startedAt);
    context.sink.chunk(input.reply);
  }

  const committed = await commitTurn({
    turn,
    reply: input.reply,
    intent: input.intent,
    slots: input.slots,
    filled: input.filled,
    revised: input.revised ?? [],
    score: input.score,
    qualified: input.qualified,
    fallbackStreak: input.fallbackStreak,
    handoffReason: input.handoffReason ?? null,
    optedOut: input.optedOut ?? false,
    guard: input.guard ?? null,
    meeting: input.meeting ?? null,
    reconfirmation: input.reconfirmation === true,
    ...(input.scheduling === undefined ? {} : { scheduling: input.scheduling }),
    // FR-009: a question left for the lead, or times awaiting a pick. Handoff
    // and opt-out never reach here with either set; the guards catch the rest.
    awaitingLead: input.question !== null || (input.scheduling?.options?.length ?? 0) > 0 || input.meeting != null,
    toolCalls: input.toolCalls ?? [],
    // Absent rather than empty: `commitTurn` writes the key only when there are
    // cards, and no search is not the same thing as a search that found nothing.
    ...(input.propertyIds !== undefined && input.propertyIds.length > 0
      ? { propertyIds: input.propertyIds }
      : {}),
    traceId: context.traceId ?? null,
    now: context.now,
  });

  context.sink.done();

  return {
    status: "committed",
    conversationId: turn.conversation.id,
    messageId: committed.messageId,
    repliesToMessageId: committed.repliesToMessageId,
    reply: input.reply,
    intent: input.intent,
    slots: input.slots,
    filled: input.filled,
    score: committed.score,
    qualified: input.qualified,
    question: input.question,
    guard: input.guard ?? null,
    handoffReason: input.handoffReason ?? null,
    meeting: input.meeting ?? null,
    propertyCodes: input.propertyCodes ?? [],
    events: committed.events,
    outcome: input.outcome,
    stage: committed.leadStatus,
  };
}

/** What every ending of a running turn reports, whichever path it took. */
export type TurnBase = Pick<
  FinishInput,
  "turn" | "context" | "intent" | "slots" | "filled" | "revised" | "score" | "qualified" | "fallbackStreak"
>;
