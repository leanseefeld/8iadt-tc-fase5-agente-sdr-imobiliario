import { generateText, streamText, type ModelMessage } from "ai";
import { getConfig } from "../core/config.ts";
import { modelTelemetry, rememberLeadName, withTurnTrace } from "../core/langfuse.ts";
import { createLogger } from "../core/logging.ts";
import { handoffDecision, shouldProposeMeeting, type HandoffReason } from "../domain/handoff.ts";
import { reconfirmationKeys } from "../domain/revision.ts";
import { looksLikeInjection, looksLikeSteering } from "../domain/injection.ts";
import { createReplyGuard, figuresIn, splitSentences } from "../domain/reply-guards.ts";
import { scoreLead } from "../domain/score.ts";
import {
  CONTACT_SLOTS,
  hasEvidence,
  isQualified,
  mergeSlots,
  nextQuestion,
  partitionSlotChanges,
  qualifyingSlots,
  upcomingSlots,
  type Askable,
  type Intent,
  type Question,
  type SlotExtraction,
  type SlotKey,
  type Slots,
} from "../domain/slots.ts";
import {
  lastReschedulingId,
  pendingChange,
  claimTurn,
  commitTurn,
  lastSearchOutcome,
  lastOfferedOptions,
  lastOfferedType,
  lastTurnWasReconfirmation,
  latestInterestedProperty,
  loadTurn,
  resolvePropertyRef,
  type PropertyRef,
  type SchedulingRecord,
  offerOutstanding,
  releaseTurn,
  type CommittedToolCall,
  type LeadStatus,
  type LoadedTurn,
} from "../services/conversation.ts";
import {
  CANNOT_ACT_REPLY,
  EXTRACTION_FAILURE_REPLY,
  MODEL_FAILURE_REPLY,
  OPT_OUT_REPLY,
  PRE_CONSENT_REPLY,
  handoffReply,
  SUGGESTION_REPLY,
  guardedReply,
  noMatchReply,
  refusalReply,
} from "./prompts/fallback.ts";
import { reconfirmationSentence } from "./prompts/reconfirm.ts";
import { REPLY_SYSTEM_PROMPT, extractionSystemPrompt, turnBriefing } from "./prompts/system.ts";
import { getJsonModel, modelCall } from "./provider.ts";
import { plausiblyAnswers, recoverSlot } from "./recovery.ts";
import { act } from "./act.ts";
import { boundaryOffer, offerOutcome, readAct, readRemainder, settleAct, type MessageAct } from "./decide/boundary.ts";
import { asksForMoreProperties, readAcknowledgement, readOptionPick } from "./lexicon.ts";
import { chooseMeeting, matchAnswer, parseWhen } from "./meeting-change.ts";
import { actionTools, type SearchOutcome } from "./tools/index.ts";
import {
  closingSentence,
  closingSummary,
  BOUNDARY_FALLBACK_SENTENCE,
  BOUNDARY_OFFER_QUESTION,
  MEETING_LIMIT_SENTENCE,
  NO_MEETING_TO_CHANGE_SENTENCE,
  cancelQuestion,
  cancelledSentence,
  keptSentence,
  rescheduleOptionsSentence,
  rescheduledSentence,
  whichOneSentence,
  type MeetingRef,
  NO_PROPERTY_YET_SENTENCE,
  PHONE_OFFER_SENTENCE,
  VISIT_NEEDS_PROPERTY_SENTENCE,
  ATTENDEE_UNKNOWN_SENTENCE,
  BOOKING_REFUSED,
  DECLINE_ACKNOWLEDGEMENT,
  DETAILS_FIRST_SENTENCE,
  NO_OPTIONS_FOR_CONSTRAINT_SENTENCE,
  NO_OPTIONS_SENTENCE,
  bookingBriefing,
  confirmationSentence,
  optionsSentence,
  stillValidSentence,
} from "./prompts/meeting.ts";
import {
  MAX_UPCOMING_MEETINGS,
  cancelAppointment,
  computeRescheduleOptions,
  listUpcomingMeetings,
  type RescheduleResult,
  type UpcomingMeeting,
  declineProposal,
  hasConfirmedFutureAppointment,
  proposeAppointment,
  type BookResult,
} from "../services/scheduling.ts";
import type { MeetingType, Preference, Weekday } from "../domain/scheduling.ts";
import { isTrue, normalizeExtraction } from "./tools/update-slots.ts";

/**
 * One turn, stateless (FR-007): everything it needs is loaded at the start and
 * written back at the end, in `services/conversation.commitTurn`'s one
 * transaction. Nothing survives between turns except rows.
 *
 * It is two model calls, not one, and that is the load-bearing decision here.
 * The question a turn asks is the first *still empty* slot **after** the lead's
 * message has been read — US1 scenario 1 says so explicitly — so the question
 * cannot be computed before the extraction. Asking one model call to extract and
 * to phrase at once would mean phrasing against the state the turn started in,
 * and the reply would re-ask what the lead had just answered. So:
 *
 *   1. extract — `updateSlots`, tools on, no voice, nothing streamed;
 *   2. merge in code — `mergeSlots`, then `recoverSlot` for the pending slot if
 *      the extraction missed it (FR-011);
 *   3. compute — score, stage, handoff, meeting, and the ONE next question;
 *   4. phrase — the reply, streamed, no tools at all, guarded per sentence.
 *
 * Step 4 has no tools on purpose: given a tool and asked for a sentence, this
 * model picks the tool. Step 3 is where every decision is made, in code, which
 * is constitution V in one paragraph.
 */

const log = createLogger("app", { module: "agent/orchestrator" });

/**
 * Where approved sentences go. The turn does not know whether it is feeding an
 * SSE stream, a test or nothing at all — spec 004's group C attaches the stream
 * to this interface without the orchestrator learning about HTTP.
 */
export interface ReplySink {
  chunk(text: string): void;
  done(): void;
}

/** The sink the tests use, and the one a turn with no listener gets. */
export function collectingSink(): ReplySink & { chunks: string[]; text(): string } {
  const chunks: string[] = [];
  return {
    chunks,
    text: () => chunks.join(" "),
    chunk: (text) => void chunks.push(text),
    done: () => {},
  };
}

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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * FR-017: the first thing a lead reads never lands faster than a person could
 * have typed it — including the replies no model wrote, or the opt-out would
 * arrive instantly and every other reply would not.
 */
async function pauseBeforeFirstChunk(startedAt: number): Promise<void> {
  const { minMs, maxMs } = getConfig().CHAT_TYPING_DELAY_MS;
  const target = minMs + Math.random() * Math.max(0, maxMs - minMs);
  const remaining = target - (Date.now() - startedAt);
  if (remaining > 0) await sleep(remaining);
}

// ---------------------------------------------------------------------------
// Prompt input
// ---------------------------------------------------------------------------

/**
 * Gemma's chat template wants the roles to alternate, so consecutive messages
 * from the same side are joined rather than sent as two turns. Everything the
 * model sees is already bounded to `MODEL_HISTORY_WINDOW` by `loadTurn`.
 */
function toModelMessages(turn: LoadedTurn, limit?: number): ModelMessage[] {
  const messages: ModelMessage[] = [];
  // Handovers are woven into the transcript in timestamp order, not described
  // in the briefing, for the reason the briefing itself moved: everything
  // before the final user turn has to stay byte-identical between calls or the
  // provider's prefix cache throws the whole conversation away (measured at
  // 82–84% hits in spec 004). A marker beside the message it explains is
  // cached with it; the same fact in the briefing would be re-encoded forever.
  const pending = [...turn.handovers];

  const say = (role: "user" | "assistant", content: string) => {
    const previous = messages.at(-1);
    if (previous !== undefined && previous.role === role) {
      previous.content = `${previous.content as string}\n${content}`;
      return;
    }
    messages.push({ role, content });
  };

  for (const message of turn.history) {
    if (message.role === "system") continue;

    while (pending.length > 0 && pending[0].at <= message.createdAt) {
      const handover = pending.shift();
      if (handover === undefined) break;
      say(
        "assistant",
        handover.kind === "assumed"
          ? `[${handover.name} (corretor) assumiu a conversa]`
          : `[${handover.name} devolveu a conversa para você]`,
      );
    }

    const role = message.role === "lead" ? "user" : "assistant";
    // A broker's words arriving as `assistant` is how this agent used to read
    // "Oi, aqui é a Ana" as something it had said itself. The label is the
    // whole fix: the model is told which assistant lines are not its own.
    const authorId = message.metadata.userId;
    const author = typeof authorId === "string" ? turn.brokerNames[authorId] : undefined;
    const content =
      message.role === "broker"
        ? `[${author ?? "Corretor"} escreveu] ${message.content}`
        : message.content;
    say(role, content);
  }

  for (const handover of pending) {
    say(
      "assistant",
      handover.kind === "assumed"
        ? `[${handover.name} (corretor) assumiu a conversa]`
        : `[${handover.name} devolveu a conversa para você]`,
    );
  }

  const trimmed = limit === undefined ? messages : messages.slice(-limit);
  // A turn exists because a lead wrote; the model must end on their words.
  if (trimmed.at(-1)?.role !== "user") {
    trimmed.push({ role: "user", content: unansweredText(turn) });
  }
  return trimmed;
}

/**
 * Puts the turn's briefing immediately before the lead's own words, inside the
 * last user turn.
 *
 * Two constraints decide the shape. AI SDK 7 refuses a `system` message inside
 * `messages` ("use the instructions option instead"), and Gemma's template wants
 * the roles to alternate, so the briefing cannot be a message of its own either
 * way. It therefore rides in the final user turn, fenced and labelled, with the
 * lead's text last — instructions, then the thing to answer.
 *
 * The caching property survives intact, which is the whole reason for the move:
 * everything before this last turn is byte-identical to the previous call, so
 * the server's prefix cache keeps the entire conversation instead of discarding
 * it behind a system prompt that changed. The labels also matter on their own —
 * the model is told which half is ours and which half is the lead's, and the
 * lead's half is the half it must answer.
 */
function briefed(messages: ModelMessage[], briefing: string): ModelMessage[] {
  const fenced = (leadText: string) =>
    [
      "[CONTEXTO PARA VOCÊ — instruções do sistema, não é mensagem da pessoa]",
      briefing,
      "",
      "[MENSAGEM DA PESSOA — responda a isto]",
      leadText,
    ].join("\n");

  const last = messages.at(-1);
  if (last === undefined || last.role !== "user") {
    return [...messages, { role: "user", content: fenced("") }];
  }
  return [
    ...messages.slice(0, -1),
    { role: "user", content: fenced(last.content as string) },
  ];
}

/** FR-044: one turn answers every lead message left unanswered, together. */
function unansweredText(turn: LoadedTurn): string {
  return turn.unanswered.map((message) => message.content).join("\n");
}

// ---------------------------------------------------------------------------
// 1 · Extraction
// ---------------------------------------------------------------------------

interface Extraction {
  /** What the message said, recorded for the transcript and the trace. */
  calls: CommittedToolCall[];
  /** The two things a message can be besides an answer. */
  leadAskedForHuman: boolean;
  optedOut: boolean;
  /** The extraction produced at least one non-null slot. */
  saidSomething: boolean;
  /** The lead tried to convey something, rather than reacting or greeting. */
  attemptedAnswer: boolean;
  /** The lead asked what the agent is filtering by. */
  askedAboutCriteria: boolean;
  /** Spec 006: what the message says about a meeting. Code decides what each fact does. */
  scheduling: SchedulingFacts;
  /** Closed-set slots the evidence gate refused — understood, but not trusted. */
  dropped: SlotKey[];
  /** Spec 015: what the message does, as the model read it. */
  act: MessageAct | null;
  /** Spec 015: the part of the message no other field captured. */
  remainder: string | null;
  failed: boolean;
}

interface SchedulingFacts {
  declinedOffer: boolean;
  askedForTimes: boolean;
  pickedTime: boolean;
  preference: Preference;
  propertyRef: PropertyRef | null;
  askedWhoAttends: boolean;
  /**
   * Spec 009: cancel or move a meeting already confirmed. `either` is the 4-bit
   * model writing `true` instead of which one; the turn decides from the text.
   */
  changeRequest: "cancel" | "reschedule" | "either" | null;
  /** Spec 009: a yes or a no to the confirmation question just asked. */
  answer: "yes" | "no" | null;
  /** FR-004e/f: the lead asked for a visit or for a phone conversation. */
  meetingKind: "visit" | "call" | null;
  /** FR-005h: a meeting in a format the agency doesn't offer (office, video, …). */
  unsupportedMeeting: boolean;
  /** FR-005i: something about a visit the agency doesn't do (a ride, choosing the broker by a trait, …). */
  outOfScopeRequest: boolean;
}

const NO_SCHEDULING: SchedulingFacts = {
  declinedOffer: false,
  askedForTimes: false,
  pickedTime: false,
  preference: {},
  propertyRef: null,
  askedWhoAttends: false,
  changeRequest: null,
  answer: null,
  meetingKind: null,
  unsupportedMeeting: false,
  outOfScopeRequest: false,
};

const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** Read spec 006's facts off the extraction's JSON. Anything malformed is simply absent. */
export function readSchedulingFacts(object: Record<string, unknown>): SchedulingFacts {
  const preference: Preference = {};
  if (typeof object.preferredWeekday === "string" && (WEEKDAYS as readonly string[]).includes(object.preferredWeekday)) {
    preference.weekday = object.preferredWeekday as Weekday;
  }
  if (object.preferredPeriod === "morning" || object.preferredPeriod === "afternoon") {
    preference.period = object.preferredPeriod;
  }
  const code = typeof object.propertyCode === "string" ? object.propertyCode.trim() : "";
  const position = Number(object.propertyPosition);
  const propertyRef: PropertyRef | null =
    code !== "" ? { code } : Number.isInteger(position) && position > 0 ? { position } : null;
  return {
    declinedOffer: isTrue(object.declinedOffer),
    askedForTimes: isTrue(object.askedForTimes),
    pickedTime: isTrue(object.pickedTime),
    preference,
    propertyRef,
    askedWhoAttends: isTrue(object.askedWhoAttends),
    changeRequest:
      object.changeRequest === "cancel" || object.changeRequest === "reschedule"
        ? object.changeRequest
        : isTrue(object.changeRequest)
          ? "either"
          : null,
    answer: object.answer === "yes" || object.answer === "no" ? object.answer : null,
    meetingKind: object.meetingKind === "visit" || object.meetingKind === "call" ? object.meetingKind : null,
    unsupportedMeeting: isTrue(object.unsupportedMeeting),
    outOfScopeRequest: isTrue(object.outOfScopeRequest),
  };
}

const NOTHING: Extraction = {
  calls: [],
  leadAskedForHuman: false,
  optedOut: false,
  saidSomething: false,
  attemptedAnswer: false,
  askedAboutCriteria: false,
  scheduling: NO_SCHEDULING,
  dropped: [],
  act: null,
  remainder: null,
  failed: true,
};

/**
 * The three-state streak (FR-003, FR-003d). Learning resets it. A conversational
 * turn and a failed extraction hold it. An attempt the system could not use
 * advances it. A dropped slot also holds, because it was understood.
 */
export type ReplyKind = "confirmation" | "options" | "search" | "criteria" | "reconfirmation" | "question";

/**
 * FR-005g: when several kinds of reply apply to one turn, exactly one decides
 * what the reply says — what the lead most needs to know first. `options` also
 * covers an answer that there are no times, which answers the same request. A
 * decline acknowledgement is not here: it is a prefix, not a competitor.
 */
export function replyKind(turn: {
  booked: boolean;
  options: boolean;
  searched: boolean;
  askedAboutCriteria: boolean;
  reconfirmation: boolean;
}): ReplyKind {
  if (turn.booked) return "confirmation";
  if (turn.options) return "options";
  if (turn.searched) return "search";
  if (turn.askedAboutCriteria) return "criteria";
  if (turn.reconfirmation) return "reconfirmation";
  return "question";
}

/** When a second, narrow extraction call is worth making for the pending slot. */
export function shouldRecover(input: {
  stillPending: boolean;
  pendingIsIntent: boolean;
  saidSomething: boolean;
  attemptedAnswer: boolean;
  leadText: string;
}): boolean {
  return (
    input.stillPending &&
    input.attemptedAnswer &&
    (input.pendingIsIntent || !input.saidSomething) &&
    plausiblyAnswers(input.leadText)
  );
}

export function accountTurn(
  currentStreak: number,
  turn: {
    learnedSomething: boolean;
    extractionFailed: boolean;
    attemptedAnswer: boolean;
    droppedCount: number;
    /** A plain "yes" to the previous reconfirmation. Not a turn that learned nothing. */
    confirming?: boolean;
    /** Asked what the current criteria are. Not a misunderstanding (FR-018). */
    askedAboutCriteria?: boolean;
    /**
     * Spec 006: the lead acted on a meeting — declined it, asked for times,
     * picked one, or pointed at a property. Understood and acted on, so it resets
     * the count like learning a slot does.
     */
    acted?: boolean;
    /**
     * Spec 006 FR-005h/i: the lead asked for something the agency doesn't do.
     * Understood, and still a request the agent can't act on — the streak
     * advances, so a second one in a row hands off.
     */
    refused?: boolean;
    /**
     * Ignored. It used to keep a steering attempt off the streak. That shield
     * is gone (FR-026); the call site still records the attempt as a guard.
     */
    steering?: boolean;
  },
): { notUnderstood: boolean; fallbackStreak: number } {
  // The steering shield is gone. Callers still pass the flag so the call site
  // shows the attempt was recognised; the count does not read it.
  void turn.steering;
  if (turn.refused === true) return { notUnderstood: true, fallbackStreak: currentStreak + 1 };
  if (turn.learnedSomething || turn.acted === true) return { notUnderstood: false, fallbackStreak: 0 };
  // A failed extraction is not consulted for `attemptedAnswer` (FR-003c).
  // A confirmation, or a question about the current criteria, holds the count.
  if (
    turn.extractionFailed ||
    !turn.attemptedAnswer ||
    turn.confirming === true ||
    turn.askedAboutCriteria === true
  ) {
    return { notUnderstood: false, fallbackStreak: currentStreak };
  }
  const notUnderstood = turn.droppedCount === 0;
  return {
    notUnderstood,
    fallbackStreak: notUnderstood ? currentStreak + 1 : currentStreak,
  };
}

/**
 * One call: read the lead's message into slots.
 *
 * Not a chat call with tools, and not a schema either. Asked conversationally
 * with `toolChoice: "required"`, this model answered the lead in prose instead
 * of calling the tool in 38% of 53 measured turns. Sent a JSON *schema*, oMLX
 * accepted it and then failed to constrain the model to it — a bare
 * `["zona sul"]` run to the token ceiling on most calls, and on every call at
 * temperature 0. Plain JSON mode with the field guide in the prompt parsed 30 of
 * 30 with no wrong values, so that is what this does: ask for JSON, parse it
 * here, and let `normalizeExtraction` and `mergeSlots` do the repair they always
 * did.
 *
 * The output cap is its own and small: an object of twelve fields needs a
 * fraction of what a reply needs, and the shared ceiling was paying for prose.
 */
const EXTRACTION_MAX_TOKENS = 300;

/** One retry, because the failure is detectable and the sampler is the cause. */
const EXTRACTION_ATTEMPTS = 2;

function parseExtraction(text: string): Record<string, unknown> | null {
  // The model occasionally wraps the object in a fence or a sentence; the first
  // balanced-looking object is what it meant either way.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Drops a closed-set value the lead never raised.
 *
 * FR-010's "never invent" as a property of the code rather than a request made
 * of a 4-bit model: asked to read "quero comprar apartamento de 2 quartos na
 * zona sul até 700 mil", the model filled `urgency: "exploring"` about someone
 * who had said nothing about prazo, which skipped the very question the script
 * was on. Only the three word-spoken slots are gated — see `EVIDENCE_WORDS`.
 */
function withoutInventedSlots(
  extracted: SlotExtraction,
  leadText: string,
  pending: Askable | null,
): { slots: SlotExtraction; dropped: SlotKey[] } {
  const kept: Record<string, unknown> = { ...extracted };
  const dropped: SlotKey[] = [];

  for (const slot of ["urgency", "investorProfile", "returnExpectation"] as const) {
    if (kept[slot] === undefined) continue;
    // The script just asked about this slot, so an answer to it is grounded by
    // the exchange and needs no vocabulary of its own. This is the common case
    // and the one the word list is worst at: someone answering "inicial" to
    // "...ou ainda é uma pesquisa inicial?" is echoing the question, and the
    // gate dropped it, told them it had not understood, and counted a fallback.
    if (slot === pending) continue;
    if (hasEvidence(slot, leadText)) continue;
    log.info({ slot, value: kept[slot] }, "dropped a slot the lead never raised");
    dropped.push(slot);
    delete kept[slot];
  }

  return { slots: kept as SlotExtraction, dropped };
}

async function extract(turn: LoadedTurn, pending: Askable | null): Promise<Extraction> {
  const config = getConfig();

  for (let attempt = 1; attempt <= EXTRACTION_ATTEMPTS; attempt++) {
    try {
      const { text } = await generateText({
        model: getJsonModel(),
        ...modelTelemetry("model.extract"),
        maxRetries: config.MODEL_MAX_RETRIES,
        abortSignal: AbortSignal.timeout(config.MODEL_TIMEOUT_MS),
        maxOutputTokens: Math.min(config.MODEL_MAX_OUTPUT_TOKENS, EXTRACTION_MAX_TOKENS),
        system: extractionSystemPrompt(),
        messages: toModelMessages(turn, 4),
      });

      const object = parseExtraction(text);
      if (object === null) {
        log.warn({ attempt }, "extraction did not come back as an object");
        continue;
      }

      const gated = withoutInventedSlots(normalizeExtraction(object), unansweredText(turn), pending);
      const extracted = gated.slots;
      // Spec 015: what code reads by itself. A bare "valeu!" requests nothing —
      // the model sometimes echoes the refusal it read one message earlier, and
      // a second refusal is a handoff. "Outros imóveis" is the criteria question,
      // never something left over for the team.
      const said = unansweredText(turn);
      const bare = readAcknowledgement(said) !== null;
      const moreProperties = asksForMoreProperties(said);
      const askedForHuman = isTrue(object.askedForHuman) && !bare;
      const optedOut = isTrue(object.optOut) && !bare;
      const attemptedAnswer = isTrue(object.attemptedAnswer);
      const askedAboutCriteria = isTrue(object.askedAboutCriteria) || moreProperties;
      const read = readSchedulingFacts(object);
      const scheduling = bare ? { ...read, unsupportedMeeting: false, outOfScopeRequest: false } : read;

      // The transcript and the spans keep the vocabulary they had when this was
      // a tool call: `commitTurn` writes these, not the AI SDK, and
      // `contracts/observability.md` §2 names them. What changed is how the
      // model was asked, not what the turn decided.
      const calls: CommittedToolCall[] = [{ name: "updateSlots", arguments: extracted }];
      if (askedForHuman) calls.push({ name: "requestHandoff", arguments: { reason: "asked" } });
      if (optedOut) calls.push({ name: "optOut", arguments: {} });

      return {
        calls,
        leadAskedForHuman: askedForHuman,
        optedOut,
        saidSomething: Object.keys(extracted).length > 0,
        attemptedAnswer,
        askedAboutCriteria,
        scheduling,
        dropped: gated.dropped,
        act: readAct(object.messageAct),
        remainder: moreProperties ? null : readRemainder(object.uncovered),
        failed: false,
      };
    } catch (error) {
      // A timeout or a dead provider. Both mean the same thing to the turn:
      // nothing was learned, and the lead still gets an answer.
      log.warn({ err: (error as Error).message, attempt }, "extraction call failed");
    }
  }

  return NOTHING;
}

// ---------------------------------------------------------------------------
// 4 · Phrasing, guarded at sentence boundaries
// ---------------------------------------------------------------------------

interface PhrasedReply {
  chunks: string[];
  /** The guard that stopped the stream, when one did. */
  guard: string | null;
  failed: boolean;
}

/**
 * A sentence is only complete when the buffer ends on its terminator; anything
 * after that terminator is the start of the next one and must wait, or the guard
 * would judge half a sentence.
 */
export function drain(buffer: string, final: boolean): { ready: string[]; rest: string } {
  const sentences = splitSentences(buffer);
  if (sentences.length === 0) return { ready: [], rest: final ? "" : buffer };
  if (final || /[.!?]["')\]]?\s*$/.test(buffer)) return { ready: sentences, rest: "" };
  // The unfinished sentence is carried over verbatim, trailing space included.
  // `splitSentences` trims, and a stream chunk that happened to end on "de "
  // would otherwise have the next chunk's "2 quartos" glued straight onto it —
  // "de2 quartos", which the lead saw. Where a chunk ends is the provider's
  // choice and shifts under load, which is why four parallel conversations
  // exposed it and single ones rarely did. The trimmed tail is the last
  // occurrence in the buffer, so slicing from there keeps only its own suffix.
  const last = sentences.at(-1) as string;
  return { ready: sentences.slice(0, -1), rest: buffer.slice(buffer.lastIndexOf(last)) };
}

interface PhraseInput {
  turn: LoadedTurn;
  /** This turn's volatile half, delivered at the end rather than at the top. */
  briefing: string;
  question: Question | null;
  pendingSlot: Askable | null;
  nextSlot: Askable | null;
  allowedAmounts: number[];
  allowedPercentages: number[];
  /**
   * What goes out when a guard throws the whole reply away. Defaults to the
   * script's question; a turn whose job is not to ask one (the cards, the empty
   * result) hands its own sentence in, or the lead would get "anotado!" under
   * three property cards.
   */
  fallbackText?: string;
  /**
   * Spec 006 FR-005g: a code-written sentence sent before the phrased reply —
   * the decline acknowledgement, or "complete your details first". It does not
   * compete with the reply; it precedes whatever wins.
   */
  prefix?: string;
  /**
   * Spec 015: a question the reply must end up asking. When the phrased reply
   * doesn't ask anything, it goes out after it — an offer the lead can't see is
   * no offer, and a "sim" to nothing would still hand the conversation off.
   */
  mustAsk?: string;
  sink: ReplySink;
  startedAt: number;
}

async function phrase(input: PhraseInput): Promise<PhrasedReply> {
  const guard = createReplyGuard({
    pendingSlot: input.pendingSlot,
    nextSlot: input.nextSlot,
    allowedAmounts: input.allowedAmounts,
    allowedPercentages: input.allowedPercentages,
  });

  const chunks: string[] = [];
  let rejectedBy: string | null = null;
  let failed = false;
  let buffer = "";
  let delayed = false;

  /** FR-017: the first sentence never lands faster than a person could type it. */
  const emit = async (sentence: string): Promise<void> => {
    if (!delayed) {
      delayed = true;
      await pauseBeforeFirstChunk(input.startedAt);
    }
    chunks.push(sentence);
    input.sink.chunk(sentence);
  };

  try {
    if (input.prefix !== undefined) await emit(input.prefix);
    const stream = streamText({
      ...modelCall(),
      ...modelTelemetry("model.reply"),
      system: REPLY_SYSTEM_PROMPT,
      messages: briefed(toModelMessages(input.turn), input.briefing),
    });

    outer: for await (const part of stream.fullStream) {
      if (part.type === "error") {
        failed = true;
        log.warn({ err: String(part.error) }, "phrasing call failed");
        break;
      }
      if (part.type !== "text-delta") continue;

      buffer += part.text;
      const { ready, rest } = drain(buffer, false);
      buffer = rest;
      for (const sentence of ready) {
        const verdict = guard.check(sentence);
        if (!verdict.ok) {
          rejectedBy = verdict.guard;
          log.info({ guard: verdict.guard, reason: verdict.reason }, "reply guard rejected a chunk");
          break outer;
        }
        await emit(sentence);
      }
    }

    if (rejectedBy === null && !failed) {
      for (const sentence of drain(buffer, true).ready) {
        const verdict = guard.check(sentence);
        if (!verdict.ok) {
          rejectedBy = verdict.guard;
          break;
        }
        await emit(sentence);
      }
    }
  } catch (error) {
    failed = true;
    log.warn({ err: (error as Error).message }, "phrasing call threw");
  }

  // Nothing survived: the lead still gets an answer, and which failure it was
  // decides which one (FR-014 for a dead provider, FR-012 for a bad reply).
  if (chunks.length === 0) {
    const replacement = failed
      ? MODEL_FAILURE_REPLY
      : (input.fallbackText ?? guardedReply(input.question));
    await emit(replacement);
    return { chunks, guard: rejectedBy, failed };
  }

  // A guard cut the reply short before it asked anything. The script still has
  // to move, so the chosen question goes out on its own.
  if (rejectedBy !== null && input.question !== null && !chunks.some((c) => c.includes("?"))) {
    await emit(input.question.question);
  }
  if (input.mustAsk !== undefined && !chunks.some((c) => c.includes("?"))) {
    await emit(input.mustAsk);
  }

  return { chunks, guard: rejectedBy, failed };
}

// ---------------------------------------------------------------------------
// Ending a turn
// ---------------------------------------------------------------------------

interface FinishInput {
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
async function finish(input: FinishInput): Promise<TurnResult> {
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

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

export async function runTurn(options: RunTurnOptions): Promise<TurnResult> {
  const sink = options.sink ?? collectingSink();
  const now = options.now ?? new Date();
  const startedAt = Date.now();

  const loaded = await loadTurn({ conversationId: options.conversationId });
  if (loaded === null) return { status: "skipped", reason: "noConversation" };

  // FR-028: a broker owns a paused conversation and the agent stays quiet.
  if (loaded.conversation.status !== "active") {
    return { status: "skipped", reason: "notActive" };
  }
  if (loaded.unanswered.length === 0) {
    return { status: "skipped", reason: "nothingUnanswered" };
  }

  // FR-018/019, and the one gate that must sit ahead of the model call: text
  // typed before "Aceito" gets the fixed template, costs nothing and is not a
  // turn. `recordLeadMessage` refuses it earlier too — this is the second lock,
  // because the worker's consumer can reach a turn without passing through it.
  if (loaded.lead.consentAt === null) {
    sink.chunk(PRE_CONSENT_REPLY);
    sink.done();
    return { status: "skipped", reason: "preConsent", reply: PRE_CONSENT_REPLY };
  }

  // FR-043: at most one turn per conversation, decided by the row.
  if (!(await claimTurn(loaded.conversation.id, now))) {
    return { status: "skipped", reason: "alreadyRunning" };
  }

  // The whole turn, inside its `conversation.turn` trace (contract §1). With
  // Langfuse unconfigured `withTurnTrace` is `fn(no trace)` and the turn is
  // identical, down to the `null` trace id every event row then carries
  // (FR-050). The skipped turns above are deliberately outside it: they answer
  // nothing and are not turns.
  try {
    return await withTurnTrace(
      {
        agencyId: loaded.agency.id,
        leadId: loaded.lead.id,
        conversationId: loaded.conversation.id,
        channel: loaded.lead.channel,
        intent: loaded.lead.intent,
        leadName: loaded.conversation.slots.name,
        leadText: unansweredText(loaded),
        // Recomputed here rather than read out of `run`: `nextQuestion` is pure,
        // and the trace wants the slot the script was on *before* the turn.
        pendingSlot:
          nextQuestion(
            { intent: loaded.lead.intent, slots: loaded.conversation.slots },
            true,
          )?.slot ?? null,
      },
      async (trace) => {
        const result = await run(loaded, {
          ...options,
          sink,
          now,
          startedAt,
          traceId: options.traceId ?? trace.traceId,
        });
        if (result.status === "committed") {
          trace.finish({
            score: result.score,
            stage: result.stage,
            outcome: result.outcome,
            reply: result.reply,
          });
        }
        return result;
      },
    );
  } catch (error) {
    // Nothing was committed, so the same lead messages are still unanswered and
    // the next sweep answers them. Only the claim has to be given back.
    await releaseTurn(loaded.conversation.id);
    log.error({ err: (error as Error).message }, "turn failed before commit");
    throw error;
  }
}

interface RunContext extends RunTurnOptions {
  sink: ReplySink;
  now: Date;
  startedAt: number;
}

/**
 * Spec 006 FR-004e/f: what a meeting offer is for. An investor always gets a
 * call (FR-003a). Otherwise a visit needs a property: with one in play, it is a
 * visit; asked for the phone — or re-offering phone times already on the table
 * — it is a call; with cards on screen and none pointed at, the lead is asked
 * which one; with nothing ever shown, the phone is what there is. Phone times
 * already on the table stay a call even with a property in play.
 */
export function meetingTarget(input: {
  intent: Intent;
  kind: "visit" | "call" | null;
  property: { id: string; code: string } | null;
  reofferingCall: boolean;
  cardsShown: boolean;
}): "viewing" | "call" | "ask_property" {
  if (input.intent === "investment") return "call";
  if (input.kind === "call") return "call";
  // Before the property: phone times on the table stay phone times when the
  // lead narrows them ("nada na quarta?") with a visit's property in play.
  if (input.kind !== "visit" && input.reofferingCall) return "call";
  if (input.property !== null) return "viewing";
  return input.cardsShown ? "ask_property" : "call";
}

/**
 * Spec 009 — the lead changes what was booked. All decided here, in code:
 *
 * - a yes to "quer mesmo cancelar?" cancels; a no keeps it (asked first, 29/09);
 * - a yes to "quer marcar outro dia?" after a cancel offers times again;
 * - a cancel or reschedule request picks the meeting — asking "qual delas?"
 *   when it could be more than one — then asks to confirm the cancel, or offers
 *   times to move it; a time already named goes to the action loop instead.
 *
 * Nothing here names a broker (FR-005e); every sentence is code-written.
 */
async function decideChange(input: {
  turn: LoadedTurn;
  facts: SchedulingFacts;
  upcoming: UpcomingMeeting[];
  waiting: ReturnType<typeof pendingChange>;
  confirmingCancel: boolean;
  answeringWhich: boolean;
  rebooking: boolean;
  changeAsked: "cancel" | "reschedule" | null;
  answeredMeeting: MeetingRef | null;
  /** Options to move this meeting are on the table; the lead is narrowing them. */
  fixedMeeting: MeetingRef | null;
  timezone: string;
}): Promise<{
  written: string;
  scheduling?: SchedulingRecord;
  offeredType?: MeetingType | null;
  call?: CommittedToolCall;
  rescheduleTarget?: { appointmentId: string; offered: Date[] };
}> {
  const { turn, facts, upcoming, waiting, timezone } = input;
  const refs: MeetingRef[] = upcoming;

  if (input.confirmingCancel) {
    const meeting = refs.find((item) => item.id === waiting.pendingCancel);
    if (meeting === undefined) return { written: NO_MEETING_TO_CHANGE_SENTENCE };
    if (facts.answer === "no") return { written: keptSentence(meeting, timezone) };
    const cancelled = await cancelAppointment(meeting.id, turn.lead.id);
    if (!cancelled) return { written: NO_MEETING_TO_CHANGE_SENTENCE };
    const original = upcoming.find((item) => item.id === meeting.id);
    return {
      written: cancelledSentence(meeting, timezone),
      call: { name: "cancelMeeting", arguments: { appointmentId: meeting.id } },
      scheduling: {
        rebook: {
          type: meeting.type,
          propertyId: original?.propertyId ?? null,
          propertyCode: meeting.propertyCode,
        },
      },
    };
  }

  if (input.rebooking && waiting.rebook !== undefined) {
    if (upcoming.length >= MAX_UPCOMING_MEETINGS) return { written: MEETING_LIMIT_SENTENCE };
    const { rebook } = waiting;
    const offered = await offerTimes({
      turn,
      intent: turn.lead.intent,
      property:
        rebook.type === "viewing" && rebook.propertyId !== null && rebook.propertyCode !== null
          ? { id: rebook.propertyId, code: rebook.propertyCode }
          : null,
      constraint: facts.preference,
      proposalOpen: turn.proposalOpen,
      timezone,
    });
    return {
      written: offered.reply,
      offeredType: offered.type,
      call: offered.call,
      ...(offered.options.length > 0 ? { scheduling: { options: offered.options.map((at) => at.toISOString()) } } : {}),
    };
  }

  const choice = input.answeringWhich ? waiting.pendingChoice : undefined;
  const change = choice?.change ?? input.changeAsked;
  if (change === null || change === undefined) return { written: NO_MEETING_TO_CHANGE_SENTENCE };
  const pool = choice !== undefined ? refs.filter((item) => choice.ids.includes(item.id)) : refs;

  // "A primeira" answers "qual delas?" by position; otherwise narrow by what the
  // message names. While answering "qual delas?", a weekday names the meeting.
  const position = facts.propertyRef !== null && "position" in facts.propertyRef ? facts.propertyRef.position : null;
  const chosen =
    input.fixedMeeting !== null
      ? { meeting: input.fixedMeeting }
      : choice !== undefined && input.answeredMeeting !== null
      ? { meeting: input.answeredMeeting }
      : choice !== undefined && position !== null && pool[position - 1] !== undefined
      ? { meeting: pool[position - 1] }
      : chooseMeeting(
          pool,
          {
            code: facts.propertyRef !== null && "code" in facts.propertyRef ? facts.propertyRef.code : null,
            weekday: facts.preference.weekday ?? null,
            kind: facts.meetingKind,
          },
          choice !== undefined ? "cancel" : change,
          timezone,
        );

  if ("none" in chosen) {
    // Nothing still to come (it may have passed): say so, and a yes books a new one.
    const interest = latestInterestedProperty(turn);
    return {
      written: NO_MEETING_TO_CHANGE_SENTENCE,
      scheduling: {
        rebook: interest !== null
          ? { type: "viewing", propertyId: interest.id, propertyCode: interest.code }
          : { type: "call", propertyId: null, propertyCode: null },
      },
    };
  }
  if ("ask" in chosen) {
    return { written: whichOneSentence(chosen.ask, timezone), scheduling: { pendingChoice: { change, ids: chosen.ask.map((item) => item.id) } } };
  }
  const meeting = chosen.meeting;
  if (change === "cancel") {
    return { written: cancelQuestion(meeting, timezone), scheduling: { pendingCancel: meeting.id } };
  }

  // Reschedule: the action loop decides whether a new time was named, as
  // `bookMeeting` does; when the tool isn't called, the lead gets times to pick.
  return { written: "", rescheduleTarget: { appointmentId: meeting.id, offered: [] } };
}

/**
 * Spec 006: propose times and write the sentence that presents them — or the
 * sentence that says there are none. Code throughout (FR-004a, FR-005d); the
 * model never proposes. The broker chosen stays inside the service (FR-005e).
 */
async function offerTimes(input: {
  turn: LoadedTurn;
  intent: Intent;
  property: { id: string; code: string } | null;
  constraint: Preference;
  proposalOpen: boolean;
  timezone: string;
}): Promise<{ reply: string; options: Date[]; type: MeetingType | null; call: CommittedToolCall }> {
  const result = await proposeAppointment({
    agencyId: input.turn.agency.id,
    leadId: input.turn.lead.id,
    conversationId: input.turn.conversation.id,
    intent: input.intent,
    propertyId: input.property?.id ?? null,
    constraint: input.constraint,
  });
  if (result.ok) {
    const type = result.options[0].type;
    const times = result.options.map((option) => option.scheduledAt);
    const code = type === "viewing" ? (input.property?.code ?? null) : null;
    return {
      reply: optionsSentence(times, type, code, input.timezone),
      options: times,
      type,
      call: { name: "proposeMeeting", arguments: { kind: type, options: times.length } },
    };
  }
  const call: CommittedToolCall = { name: "proposeMeeting", arguments: { status: result.reason } };
  // FR-005b and FR-001 as amended: nothing matches the constraint — say so and
  // keep the earlier proposal standing. Never an automatic handoff.
  if (result.reason === "no_slots_for_constraint") {
    const earlier = input.proposalOpen ? lastOfferedOptions(input.turn) : [];
    const rest = earlier.length > 0 ? stillValidSentence(earlier, input.timezone) : "Quer tentar outro dia ou horário?";
    return { reply: `${NO_OPTIONS_FOR_CONSTRAINT_SENTENCE} ${rest}`, options: [], type: null, call };
  }
  return { reply: NO_OPTIONS_SENTENCE, options: [], type: null, call };
}

async function run(turn: LoadedTurn, context: RunContext): Promise<TurnResult> {
  const consented = turn.lead.consentAt !== null;
  const before = { intent: turn.lead.intent, slots: turn.conversation.slots };
  const pending = nextQuestion(before, consented);
  const leadText = unansweredText(turn);

  // Layer 2 of `visao-geral.md` §9, and the only place a turn ends before the
  // model is asked anything: the three phrasings that are never anything but an
  // override attempt get the written refusal, the script's own question, and no
  // token spent. No slot moves, because no extraction ran — which is FR-030's
  // "changes no slot" as a property of the control flow rather than a promise.
  if (looksLikeInjection(leadText)) {
    log.info({ conversationId: turn.conversation.id }, "input layer refused an override attempt");

    return finish({
      turn,
      context,
      reply: refusalReply(pending),
      speak: true,
      intent: before.intent,
      slots: before.slots,
      filled: [],
      score: turn.lead.score,
      qualified: isQualified(before.intent, before.slots),
      // Not a misunderstanding: the message was understood perfectly well.
      fallbackStreak: turn.conversation.fallbackStreak,
      question: pending,
      guard: "injectionInput",
      outcome: "replied",
    });
  }

  // 1 · extract
  const extraction = await extract(turn, pending?.slot ?? null);
  const toolCalls: CommittedToolCall[] = [...extraction.calls];

  // FR-003c: the provider never answered. Hold the streak and say so. Do not
  // ask the model to phrase an apology for a message it did not read.
  if (extraction.failed) {
    const held = accountTurn(turn.conversation.fallbackStreak, {
      learnedSomething: false,
      extractionFailed: true,
      attemptedAnswer: false,
      droppedCount: 0,
      steering: false,
    });
    return finish({
      turn,
      context,
      reply: EXTRACTION_FAILURE_REPLY,
      speak: true,
      intent: before.intent,
      slots: before.slots,
      filled: [],
      score: turn.lead.score,
      qualified: isQualified(before.intent, before.slots),
      fallbackStreak: held.fallbackStreak,
      question: pending,
      toolCalls,
      outcome: "replied",
    });
  }

  // 2 · merge, in code
  let merged = mergeSlots(before, {}, { consented });
  for (const call of extraction.calls) {
    if (call.name !== "updateSlots") continue;
    merged = mergeSlots(merged, normalizeExtraction(call.arguments), { consented });
  }

  // FR-011: one bounded structured call, and only for the slot that was pending.
  const stillPending =
    pending !== null &&
    (pending.slot === "intent"
      ? merged.intent === "undefined"
      : merged.slots[pending.slot] === null);

  // ...and only when the extraction itself came back empty-handed. T023's own
  // rule ("run only when no `updateSlots` arrived") had been widened to "when the
  // pending slot is still empty", and that is a different thing: a lead answering
  // the *previous* question again — "Tenho preferência por Moema ou Vila Mariana"
  // while the script is on `urgency` — produced a perfectly good `neighborhoods`
  // extraction, which merge rule 1 then dropped as already filled, and recovery
  // guessed `urgency: exploring` out of a sentence about bairros. A slot the lead
  // never spoke about is worse than a question asked once more.
  //
  // `intent` is the exception, because it is not an answer to anything: every
  // first message implies one, and the extraction reporting a neighbourhood is
  // exactly the message whose intent is worth recovering.
  // The model's own reading gates recovery too, not only the noise list: "opa,
  // tá aí?" passed `plausiblyAnswers` ("tá" is not noise), the extraction said it
  // attempted nothing, and recovery guessed the name "Opa" out of a greeting —
  // then greeted the lead by it. A slot the lead never spoke about is worse than
  // a question asked once more (see above), so an explicit "attempted nothing"
  // ends it here (US1 scenario 6).
  const recoveryDue = shouldRecover({
    stillPending,
    pendingIsIntent: pending?.slot === "intent",
    saidSomething: extraction.saidSomething,
    attemptedAnswer: extraction.attemptedAnswer,
    leadText,
  });

  // `stillPending` already implies a pending question; the check restores the
  // narrowing the extracted predicate cannot carry.
  if (recoveryDue && pending !== null) {
    const recovered = await recoverSlot({ slot: pending.slot, text: leadText });
    if (Object.keys(recovered).length > 0) {
      toolCalls.push({ name: "recoverSlot", arguments: recovered });
      merged = mergeSlots(merged, recovered, { consented });
    }
  }

  // FR-029: someone who asked to be left alone is not qualified further, not
  // phrased at by a model and not asked one more question. The sentence is
  // written down (`OPT_OUT_REPLY`), the flag and the closed conversation are
  // `commitTurn`'s, and the turn ends here.
  if (extraction.optedOut) {
    return finish({
      turn,
      context,
      reply: OPT_OUT_REPLY,
      speak: true,
      intent: merged.intent,
      slots: merged.slots,
      filled: [],
      score: scoreLead(merged.intent, merged.slots),
      qualified: isQualified(merged.intent, merged.slots),
      fallbackStreak: 0,
      question: null,
      optedOut: true,
      toolCalls,
      outcome: "opted_out",
    });
  }

  // 3 · compute — every decision below is made here, never by the model
  const { intent, slots } = merged;
  const { filled: filledThisTurn, revised: revisedThisTurn } = partitionSlotChanges(before.slots, slots);
  const intentChanged = before.intent !== "undefined" && intent !== before.intent;
  // A first identification is not `intentChanged`, but it is still something learned.
  const learnedSomething =
    filledThisTurn.length > 0 || revisedThisTurn.length > 0 || intentChanged || intent !== before.intent;
  const score = scoreLead(intent, slots);
  const qualified = isQualified(intent, slots);

  // An override attempt learns nothing on purpose. It is recorded below as a
  // guard. It no longer suppresses the streak (FR-026).
  const steering = looksLikeSteering(leadText);

  // The re-entry line is posted on handback, so a turn is rarely both a
  // greeting and a misunderstanding. The precedence stays for a conversation
  // handed back before that line existed, and for a failed write of it
  // (FR-022): the greeting wins, because the apology would be false.
  const lastHandoverEarly = turn.handovers.at(-1);
  const justReturned =
    lastHandoverEarly !== undefined &&
    lastHandoverEarly.kind === "returned" &&
    !turn.history.some(
      (message) => message.role === "agent" && message.createdAt > lastHandoverEarly.at,
    );

  // Spec 006: what the lead did about a meeting. Each fact is the model's
  // reading; what it does is decided here.
  // The day and period are also read by code from the text — weekday names,
  // manhã/tarde, hoje/amanhã — and what it finds wins over the model's guess.
  const when = parseWhen(leadText, new Date(), getConfig().FOLLOWUP_TIMEZONE);
  const facts: SchedulingFacts = {
    ...extraction.scheduling,
    preference: { ...extraction.scheduling.preference, ...when },
    // With times on the table, "a primeira" is a pick, read by code.
    pickedTime:
      extraction.scheduling.pickedTime || (readOptionPick(leadText) !== null && lastOfferedOptions(turn).length > 0),
  };
  // Open **now** — a row still `proposed` — not "an offer was ever made".
  const proposalOpen = turn.proposalOpen;
  // FR-005a: a decline counts only while a proposal is open — and a message
  // that asks for or names another day or time is not one: "pode ser domingo
  // às 7?" was read as a decline and heard "sem problema".
  const namesATime =
    facts.askedForTimes || facts.pickedTime || facts.preference.weekday !== undefined || facts.preference.period !== undefined;
  const declining = facts.declinedOffer && proposalOpen && !namesATime;
  // FR-005f: the booking tool is offered only for an actual pick.
  const picking = facts.pickedTime && proposalOpen && !declining;
  // Spec 009: the lead's meetings still to come, and what the last reply left
  // pending — a cancel to confirm, a choice between meetings, a rebook offer.
  const booked = await listUpcomingMeetings(turn.lead.id);
  const waiting = pendingChange(turn);
  const reschedulingId = lastReschedulingId(turn);
  // A pick among options offered to move a confirmed meeting.
  const movingPick =
    facts.pickedTime && !proposalOpen && reschedulingId !== null && booked.some((meeting) => meeting.id === reschedulingId);
  // "Quer mesmo cancelar?" asked: the yes or no is read from the words when the
  // extraction didn't say — "não, deixa" came back as a decline and a cancel.
  const answer: "yes" | "no" | null =
    facts.answer ??
    (waiting.pendingCancel !== undefined || waiting.rebook !== undefined || waiting.humanOffer !== undefined
      ? /^\s*(n[ãa]o|melhor n[ãa]o|deixa)(?!\p{L})/iu.test(leadText)
        ? "no"
        : /^\s*(sim|pode|isso|quero|claro|confirmo)(?!\p{L})/iu.test(leadText)
          ? "yes"
          : null
      : null);
  const confirmingCancel = waiting.pendingCancel !== undefined && answer !== null;
  const namesADay = facts.preference.weekday !== undefined || facts.preference.period !== undefined;
  // With times on the table, "nada na quarta?" is about **them** — unless the
  // message says to move or cancel something ("remarcar a visita").
  const explicitChange = /remarc|mudar|trocar|passar|cancel|desmarc/iu.test(leadText);
  const cancelWords = /cancel|desmarc|n[ãa]o vou (mais )?poder|n[ãa]o posso mais/iu.test(leadText);
  const aboutTheOffer = proposalOpen && !picking && !declining && namesADay && !explicitChange;
  // A "no" with nothing open to decline, from a lead with a meeting booked, is
  // a cancel — when it names the day or says so ("não vou mais poder na sexta"),
  // not a bare "não, obrigado" after a close.
  // `true` for "which change" is read from the words: cancelling says so.
  // "Dá pra passar pra segunda às 10?" with a meeting booked and no times on the
  // table is a reschedule even when the extraction didn't say so.
  const requested =
    facts.changeRequest === "either"
      ? cancelWords
        ? "cancel"
        : "reschedule"
      : (facts.changeRequest ??
        (explicitChange && !proposalOpen && booked.length > 0 ? (cancelWords ? "cancel" : "reschedule") : null));
  const asked: "cancel" | "reschedule" | null =
    (aboutTheOffer ? null : requested) ??
    (facts.declinedOffer && !proposalOpen && booked.length > 0 && !confirmingCancel && (namesADay || explicitChange)
      ? "cancel"
      : null);
  // Nothing still to come to change, and the lead asked for times: a new
  // booking ("podemos marcar uma nova visita pra quinta?" after the last passed).
  // A cancel that names a day is still a cancel ("não vou mais poder na terça").
  const newInstead =
    asked !== null && booked.length === 0 && (asked === "reschedule" || facts.askedForTimes || facts.meetingKind !== null);
  const changeAsked = newInstead ? null : asked;
  // Options to move a booked meeting are on the table, and the lead narrows
  // them ("e na quinta?"): the same meeting, new options.
  const narrowingMove =
    !proposalOpen &&
    !movingPick &&
    namesADay &&
    changeAsked === null &&
    reschedulingId !== null &&
    booked.some((meeting) => meeting.id === reschedulingId);
  // The answer to "qual delas?" is read against the meetings just listed.
  const answeredMeeting =
    waiting.pendingChoice !== undefined
      ? matchAnswer(
          booked.filter((meeting) => waiting.pendingChoice?.ids.includes(meeting.id)),
          leadText,
          getConfig().FOLLOWUP_TIMEZONE,
        )
      : null;
  const answeringWhich =
    waiting.pendingChoice !== undefined &&
    !confirmingCancel &&
    (answeredMeeting !== null ||
      changeAsked !== null ||
      facts.propertyRef !== null ||
      facts.preference.weekday !== undefined ||
      facts.meetingKind !== null);
  const rebooking = waiting.rebook !== undefined && answer === "yes" && changeAsked === null && !confirmingCancel;
  const changing = confirmingCancel || answeringWhich || changeAsked !== null || movingPick || rebooking || narrowingMove;
  // FR-005h/i: a request the agency cannot meet — a meeting at the office or by
  // video, a ride, a broker chosen by a personal trait. It never proposes or
  // books, and it counts against the handoff streak like any other request the
  // agent can't act on.
  const refusingFormat = facts.unsupportedMeeting && !declining && !picking;
  // "Quem vai me atender?" is FR-005e's question, not a request to choose — but
  // "quero que quem me atenda seja uma mulher" is a request, and gets refused.
  const askingWho = facts.askedWhoAttends && leadText.includes("?");
  const refusingRequest = facts.outOfScopeRequest && !askingWho && !refusingFormat && !declining && !picking;
  const refused = refusingFormat || refusingRequest;
  // FR-004b: only a property already shown here; anything else is ignored.
  const interest = facts.propertyRef === null ? null : await resolvePropertyRef(turn, facts.propertyRef);
  // A pick outranks a request for times on the same message: the extraction
  // often marks both for "a segunda", and only the pick moves the lead forward.
  // If the booking step then books nothing, the options are shown again anyway.
  // FR-005e: "quem vai me atender?" about a meeting that exists gets the
  // code-written answer, and outranks a meeting kind the extraction echoed from
  // the confirmation above it. With nothing proposed or booked, the phrased
  // reply and its system rule answer instead.
  const askingWhoAttends =
    facts.askedWhoAttends &&
    !refused &&
    !declining &&
    !picking &&
    interest === null &&
    !changing &&
    (proposalOpen || booked.length > 0);
  const wantsOffer =
    !declining &&
    !picking &&
    !refused &&
    !askingWhoAttends &&
    !changing &&
    (facts.askedForTimes || facts.meetingKind !== null || interest !== null || aboutTheOffer || newInstead);
  // FR-005b: "complete" is shouldProposeMeeting's own check, without its
  // offer-outstanding clause.
  const scriptComplete = shouldProposeMeeting(intent, slots, score, false) !== null;
  // Spec 009: up to three meetings still to come per lead.
  const atLimit = wantsOffer && scriptComplete && booked.length >= MAX_UPCOMING_MEETINGS;
  // A "no" with nothing open to decline was still understood: it is not a
  // misunderstanding to count towards a handoff, only nothing to act on.
  // Spec 015: what the message does, with a bare "obrigado" read by code; the
  // lead's answer to an offer to check something with the team; and a request,
  // question or piece of information left over, which is understood — it may
  // get the offer — and never a misunderstanding.
  const messageAct = settleAct(extraction.act, leadText, extraction.remainder);
  // A message that does something the turn already handles — picks a time,
  // changes a meeting, asks for times — is that, not a yes to the offer: "pode
  // ser a primeira opção" after an offer was read as a yes and handed off.
  const offerTaken =
    waiting.humanOffer !== undefined && !confirmingCancel && !picking && !movingPick && !changing && !wantsOffer
      ? offerOutcome(answer)
      : null;
  const openRemainder =
    extraction.remainder !== null && (messageAct === "request" || messageAct === "question" || messageAct === "inform");
  const acted =
    !refused &&
    (facts.declinedOffer ||
      picking ||
      askingWhoAttends ||
      changing ||
      (wantsOffer && !atLimit) ||
      offerTaken !== null ||
      openRemainder);

  // A misunderstanding is an attempt the system could not use (FR-003a). A
  // reaction, a greeting or a failed extraction holds the streak instead of
  // resetting it (FR-003d). A slot the evidence gate refused is not one of
  // these: the extraction read it and the code declined to trust it.
  const accounted = accountTurn(turn.conversation.fallbackStreak, {
    learnedSomething,
    extractionFailed: false,
    attemptedAnswer: extraction.attemptedAnswer,
    droppedCount: extraction.dropped.length,
    steering,
    confirming: (lastTurnWasReconfirmation(turn) && !learnedSomething) || justReturned,
    askedAboutCriteria: extraction.askedAboutCriteria,
    acted,
    refused,
  });
  const notUnderstood = accounted.notUnderstood;
  const fallbackStreak = accounted.fallbackStreak;
  // A message that picks, asks for or declines a meeting is about the meeting,
  // not a request to leave the agent: the extraction reads "a segunda" or
  // "quero agendar" as asking for a person, because the meeting is with one.
  // The explicit ask still wins on any other message (spec 004 FR-027).
  // A request refused as outside the domain ("uma corretora LGBT pra me
  // atender") names a person too; it is still not a request to leave the agent.
  const aboutTheMeeting = declining || picking || wantsOffer || askingWhoAttends || refused || changing;
  const handoffReason = handoffDecision({
    leadAskedForHuman: (extraction.leadAskedForHuman && !aboutTheMeeting) || offerTaken === "handoff",
    fallbackStreak,
  });

  // Spec 006 — the meeting, all decided in code. A code-written reply (options,
  // no options, a confirmation) wins the turn outright: FR-005g ranks 1 and 2.
  // A decline or "details first" only prefixes whatever else wins.
  const timezone = getConfig().FOLLOWUP_TIMEZONE;
  let scheduling: SchedulingRecord = interest === null ? {} : { interestedProperty: interest };
  let written: string | null = null;
  let offeredType: MeetingType | null = null;
  let prefix: string | undefined;
  // Spec 009: a meeting to move to a time the lead named — the action loop does it.
  let rescheduleTarget: { appointmentId: string; offered: Date[] } | null = movingPick
    ? { appointmentId: reschedulingId as string, offered: lastOfferedOptions(turn) }
    : null;
  const property = interest ?? latestInterestedProperty(turn);
  // Re-proposing after a refused booking keeps the kind the lead was offered.
  const offer = async (constraint: Preference) =>
    offerTimes({
      turn,
      intent,
      property: lastOfferedType(turn) === "call" ? null : property,
      constraint,
      proposalOpen,
      timezone,
    });

  if (handoffReason === null) {
    if (refused) {
      // FR-005h: after a format we don't offer, the phone — unless a call is booked.
      const callBooked = refusingFormat && (await hasConfirmedFutureAppointment(turn.lead.id, new Date(), undefined, "call"));
      written = refusingFormat && !callBooked ? `${CANNOT_ACT_REPLY} ${PHONE_OFFER_SENTENCE}` : CANNOT_ACT_REPLY;
    } else if (askingWhoAttends) {
      written = ATTENDEE_UNKNOWN_SENTENCE;
    } else if (changing && !movingPick) {
      const change = await decideChange({
        turn,
        facts: { ...facts, answer },
        upcoming: booked,
        waiting,
        confirmingCancel,
        answeringWhich,
        rebooking,
        changeAsked: narrowingMove ? "reschedule" : changeAsked,
        answeredMeeting,
        fixedMeeting: narrowingMove ? (booked.find((meeting) => meeting.id === reschedulingId) ?? null) : null,
        timezone,
      });
      written = change.written === "" ? null : change.written;
      if (change.scheduling !== undefined) scheduling = { ...scheduling, ...change.scheduling };
      if (change.offeredType !== undefined) offeredType = change.offeredType;
      if (change.call !== undefined) toolCalls.push(change.call);
      rescheduleTarget = change.rescheduleTarget ?? null;
    } else if (declining) {
      await declineProposal(turn.conversation.id);
      scheduling = { ...scheduling, declined: true };
      prefix = DECLINE_ACKNOWLEDGEMENT;
    } else if (wantsOffer && !scriptComplete) {
      // Said once. The extraction keeps reading the earlier request into the
      // next answers ("até 800 mil" after "quero marcar"), and a repeated
      // promise reads as not listening.
      // FR-004d: an interest alone asked for no times, so it gets no promise of
      // them — the phrased reply acknowledges the property and the script goes on.
      const lastAgent = [...turn.history].reverse().find((message) => message.role === "agent");
      if ((facts.askedForTimes || facts.meetingKind !== null) && lastAgent?.content.startsWith(DETAILS_FIRST_SENTENCE) !== true) {
        prefix = DETAILS_FIRST_SENTENCE;
      }
    } else if (wantsOffer && atLimit) {
      written = MEETING_LIMIT_SENTENCE;
    } else if (
      wantsOffer ||
      (!proposalOpen && booked.length === 0 && shouldProposeMeeting(intent, slots, score, offerOutstanding(turn)) !== null)
    ) {
      // FR-004e/f: a visit is about a property; the only other meeting is by phone.
      const target = meetingTarget({
        intent,
        kind: facts.meetingKind,
        property,
        reofferingCall: proposalOpen && lastOfferedType(turn) === "call",
        cardsShown: turn.history.some(
          (message) =>
            message.role === "agent" && Array.isArray(message.metadata.propertyIds) && message.metadata.propertyIds.length > 0,
        ),
      });
      if (target === "ask_property") {
        written = VISIT_NEEDS_PROPERTY_SENTENCE;
        // Counts as the offer (FR-004a's offer-outstanding fact), so it is not repeated.
        offeredType = "viewing";
      } else {
        const offered = await offerTimes({
          turn,
          intent,
          property: target === "call" ? null : property,
          constraint: wantsOffer ? facts.preference : {},
          proposalOpen,
          timezone,
        });
        toolCalls.push(offered.call);
        // A visit asked for before any property was shown: the phone is what there is.
        written =
          target === "call" && facts.meetingKind === "visit" && offered.type === "call"
            ? `${NO_PROPERTY_YET_SENTENCE} ${offered.reply}`
            : offered.reply;
        offeredType = offered.type;
        if (offered.options.length > 0) {
          scheduling = { ...scheduling, options: offered.options.map((at) => at.toISOString()) };
        }
      }
    }
  }

  const question = written !== null || handoffReason !== null ? null : nextQuestion({ intent, slots }, consented);
  const upcoming = upcomingSlots({ intent, slots }, consented);

  // A search-relevant criterion was filled or revised, and the script is far
  // enough along to search. This only decides whether `act()` is offered.
  // `investment` is refused inside the tool (FR-041), and a handoff or a
  // meeting turn has a different job.
  const searchRelevant = [...filledThisTurn, ...revisedThisTurn];
  const searchDue =
    qualified &&
    handoffReason === null &&
    written === null &&
    searchRelevant.some((slot) => qualifyingSlots(intent).includes(slot));
  // FR-005f: booking is offered only on an actual pick of an open proposal.
  const bookingDue = picking && handoffReason === null && written === null;
  // Spec 009: moving a confirmed meeting to a picked or named time.
  const rescheduleDue = rescheduleTarget !== null && handoffReason === null && written === null;

  // `searchDue` only decides whether the action call is offered. The search
  // itself runs inside the loop, as a model tool call, and may run again
  // before any reply exists (FR-013).
  const searches: SearchOutcome[] = [];
  const bookings: BookResult[] = [];
  const moves: RescheduleResult[] = [];
  const offeredTimes = bookingDue ? lastOfferedOptions(turn) : [];
  if (searchDue || bookingDue || rescheduleDue) {
    const briefing = [
      ...(searchDue ? ["Há uma busca a considerar com os critérios já registrados. Chame searchProperties."] : []),
      ...(bookingDue ? [bookingBriefing(offeredTimes, leadText, new Date(), timezone)] : []),
      ...(rescheduleDue && rescheduleTarget !== null
        ? [bookingBriefing(rescheduleTarget.offered, leadText, new Date(), timezone, "rescheduleMeeting")]
        : []),
    ].join("\n\n");
    const acted = await act({
      turn,
      briefing,
      tools: actionTools({
        ...(searchDue
          ? {
              search: {
                agencyId: turn.agency.id,
                intent,
                slots,
                onOutcome: (outcome) => {
                  searches.push(outcome);
                },
              },
            }
          : {}),
        ...(bookingDue
          ? {
              booking: {
                conversationId: turn.conversation.id,
                offered: offeredTimes,
                timezone,
                onBooked: (result) => {
                  bookings.push(result);
                },
              },
            }
          : {}),
        ...(rescheduleDue && rescheduleTarget !== null
          ? {
              reschedule: {
                appointmentId: rescheduleTarget.appointmentId,
                offered: rescheduleTarget.offered,
                timezone,
                onRescheduled: (result) => {
                  moves.push(result);
                },
              },
            }
          : {}),
      }),
    });
    for (const step of acted.steps) {
      toolCalls.push({
        name: step.name,
        arguments: step.arguments as Record<string, unknown>,
        result: step.result,
        stepIndex: step.index,
        refused: step.refused,
      });
    }
  }
  const search = searches.at(-1) ?? { properties: [], searched: false, relaxable: null };
  const propertyIds = search.properties.map((property) => property.id);

  // FR-028: a handoff is terminal for the agent, so it is written rather than
  // generated — for the same reason opt-out is. The phrasing call was asked not
  // to ask anything and asked something anyway ("Você gostaria de falar sobre
  // alguma cidade específica?"), which is a question nobody was going to answer:
  // the conversation is paused the moment this commits, so the next lead message
  // gets silence until a person arrives. `handoffReply` names the limitation and
  // says who is coming, in both flavours, and costs no model call.
  if (handoffReason !== null) {
    // A question the agent cannot act on must not be handed off as if it had
    // not been understood (FR-023). The asked-for-a-person path is unchanged.
    const reply =
      handoffReason === "fallback" && (refused || leadText.includes("?"))
        ? `${CANNOT_ACT_REPLY} Vou chamar um corretor para assumir daqui.`
        : handoffReply(handoffReason);
    return finish({
      turn,
      context,
      reply,
      speak: true,
      intent,
      slots,
      filled: filledThisTurn,
      revised: revisedThisTurn,
      score,
      qualified,
      fallbackStreak,
      question: null,
      handoffReason,
      toolCalls,
      outcome: "handoff",
    });
  }

  // FR-005, FR-006: the booking's outcome. Confirmed → the confirmation wins the
  // turn. Refused → say why and re-propose, replacing the open proposal. Picked
  // but not booked (the model called nothing) → the same options again, rather
  // than a phrased reply that might claim a booking that never happened.
  const booking = bookings.at(-1);
  if (booking?.ok) {
    written = confirmationSentence(booking.scheduledAt, booking.type, booking.propertyCode, timezone);
    scheduling = {
      ...scheduling,
      booking: {
        appointmentId: booking.appointmentId,
        scheduledAt: booking.scheduledAt.toISOString(),
        type: booking.type,
        propertyCode: booking.propertyCode,
      },
    };
  } else if (booking !== undefined && booking.reason !== "no_proposal") {
    const offered = await offer({});
    toolCalls.push(offered.call);
    written = `${BOOKING_REFUSED[booking.reason]} ${offered.reply}`;
    offeredType = offered.type;
    if (offered.options.length > 0) scheduling = { ...scheduling, options: offered.options.map((at) => at.toISOString()) };
  } else if (bookingDue && offeredTimes.length > 0) {
    const type = lastOfferedType(turn) ?? "call";
    written = optionsSentence(offeredTimes, type, type === "viewing" ? (property?.code ?? null) : null, timezone);
    offeredType = type;
    scheduling = { ...scheduling, options: offeredTimes.map((at) => at.toISOString()) };
  }

  // Spec 009: the move's outcome. Moved → the new confirmation and its card.
  // Refused → why, and options for that meeting. Nothing called → options.
  if (rescheduleDue && rescheduleTarget !== null) {
    const moved = moves.at(-1);
    const meeting = booked.find((item) => item.id === rescheduleTarget?.appointmentId);
    if (moved?.ok) {
      written = rescheduledSentence(moved.scheduledAt, moved.type, moved.propertyCode, timezone);
      scheduling = {
        ...scheduling,
        booking: {
          appointmentId: moved.appointmentId,
          scheduledAt: moved.scheduledAt.toISOString(),
          type: moved.type,
          propertyCode: moved.propertyCode,
        },
      };
    } else if (meeting !== undefined) {
      // Asked to move with no time named ("só de manhã", or nothing): options,
      // narrowed by what was said.
      const fresh = await computeRescheduleOptions(meeting.id, moved === undefined ? facts.preference : {});
      const why = moved !== undefined && moved.reason !== "gone" && moved.reason in BOOKING_REFUSED
        ? `${BOOKING_REFUSED[moved.reason as keyof typeof BOOKING_REFUSED]} `
        : "";
      if (fresh.ok) {
        written = `${why}${rescheduleOptionsSentence(meeting, fresh.options, timezone)}`;
        offeredType = fresh.type;
        toolCalls.push({ name: "proposeMeeting", arguments: { kind: fresh.type, options: fresh.options.length, reschedule: true } });
        scheduling = { ...scheduling, options: fresh.options.map((at) => at.toISOString()), reschedulingId: meeting.id };
      } else {
        written = `${why}${fresh.reason === "no_slots_for_constraint" ? `${NO_OPTIONS_FOR_CONSTRAINT_SENTENCE} Quer tentar outro dia ou horário?` : NO_OPTIONS_SENTENCE}`;
      }
    } else {
      written = NO_MEETING_TO_CHANGE_SENTENCE;
    }
  }

  // Spec 015: a request, question or piece of information left over that
  // nothing in this turn answers gets the offer to have someone from the team
  // check it. Anything that answers the lead itself — a code-written reply, a
  // search, the criteria, a revision — wins, and the offer waits for a turn
  // that has nothing better to say (plan 015).
  const teamOffer = boundaryOffer({
    act: messageAct,
    remainder: extraction.remainder,
    phrasedTurn:
      written === null &&
      !searchDue &&
      !search.searched &&
      !extraction.askedAboutCriteria &&
      revisedThisTurn.length === 0 &&
      offerTaken === null,
  });
  if (teamOffer !== null) scheduling = { ...scheduling, humanOffer: teamOffer };

  // Spec 009, decided 29/09: nothing pending, nothing asked — close. A message
  // that asks something ("?"), teaches a criterion, wants an action or leaves
  // something for the team is not a goodbye, and gets the normal turn. Spec 015:
  // a "no" to the offer closes too, and the close is the code's summary of what
  // is booked followed by the model's courtesy.
  const nothingPending =
    teamOffer === null &&
    messageAct !== "request" &&
    messageAct !== "question" &&
    written === null &&
    question === null &&
    !searchDue &&
    !proposalOpen &&
    !wantsOffer &&
    !changing &&
    !askingWhoAttends &&
    !extraction.askedAboutCriteria &&
    filledThisTurn.length === 0 &&
    revisedThisTurn.length === 0 &&
    !leadText.includes("?") &&
    (booked.length > 0 || offerOutstanding(turn) || offerTaken === "close");
  const closing = nothingPending ? { again: waiting.closing === true } : null;
  if (closing !== null) {
    scheduling = { ...scheduling, closing: true };
    // A second close in a row is the courtesy alone.
    if (!closing.again && booked.length > 0) prefix = closingSummary(booked, timezone);
  }

  if (written !== null) {
    return finish({
      turn,
      context,
      reply: prefix === undefined ? written : `${prefix} ${written}`,
      speak: true,
      intent,
      slots,
      filled: filledThisTurn,
      revised: revisedThisTurn,
      score,
      qualified,
      fallbackStreak,
      question: null,
      meeting: offeredType,
      scheduling,
      toolCalls,
      propertyIds,
      propertyCodes: search.properties.map((property) => property.code),
      outcome: offeredType !== null ? "meeting_proposed" : notUnderstood ? "fallback" : "replied",
    });
  }

  // 4 · phrase
  // The allowed figures already include the whole history, so a number a broker
  // typed is a number the agent may repeat — which is what makes "como a Ana te
  // falou, R$ 900.000" survive the `unbackedFigure` guard.
  const lead = figuresIn(`${leadText} ${turn.history.map((m) => m.content).join(" ")}`);

  // Who, if anyone, has spoken here besides the agent and the lead — and
  // whether this is the first turn since they handed it back. "First turn back"
  // is "no agent message after the return", not a flag on the conversation: the
  // rows already say it, and a flag would be a second source of truth.
  const lastHandover = turn.handovers.at(-1);
  const brokerContext =
    lastHandover === undefined
      ? undefined
      : {
          name: lastHandover.name,
          justReturned:
            lastHandover.kind === "returned" &&
            !turn.history.some(
              (message) => message.role === "agent" && message.createdAt > lastHandover.at,
            ),
        };
  // A meeting offer speaks for itself this turn. The reconfirmation waits rather
  // than replacing the offer the lead was about to hear. So does a search result
  // (FR-032): the cards, or the fact that nothing matched, are the answer to the
  // revision, and "continua assim?" over them is noise. Not computing it here also
  // keeps the turn from being recorded as a reconfirmation it never made, which
  // FR-009's derived fact depends on.
  const reconfirmKeys =
    search.searched || declining
      ? []
      : reconfirmationKeys(
          { revised: revisedThisTurn, intentChanged },
          slots,
          lastTurnWasReconfirmation(turn),
        );
  // What changed comes first, then what it puts in doubt — the shape of US4's own
  // example ("até R$ 1,2 mi, 3 quartos, Moema"). The sentence is said verbatim, so
  // without the revised value the lead's change would never be acknowledged
  // (US1 scenario 3). Contact slots never appear in a restatement.
  const reconfirmText =
    reconfirmKeys.length === 0
      ? null
      : reconfirmationSentence(slots, [
          ...revisedThisTurn.filter(
            (slot) => !(CONTACT_SLOTS as readonly string[]).includes(slot) && !reconfirmKeys.includes(slot),
          ),
          ...reconfirmKeys,
        ]);
  // FR-033: what the last search found, for a turn that did not search.
  const lastSearch = search.searched ? null : lastSearchOutcome(turn, intent);

  // A question this agent cannot act on yet still counts toward a handoff,
  // and the reply says so instead of claiming the message was not understood.
  if (notUnderstood && leadText.includes("?") && reconfirmText === null) {
    return finish({
      turn,
      context,
      reply: CANNOT_ACT_REPLY,
      speak: true,
      intent,
      slots,
      filled: filledThisTurn,
      revised: revisedThisTurn,
      score,
      qualified,
      fallbackStreak,
      question: null,
      handoffReason,
      meeting: null,
      toolCalls,
      propertyIds,
      propertyCodes: search.properties.map((property) => property.code),
      outcome: handoffReason !== null ? "handoff" : "fallback",
    });
  }

  // The offer and the close are the turn's whole job: the script's question
  // waits for the next turn (one question per message).
  const asking = teamOffer !== null || closing !== null ? null : question;
  const phrased = await phrase({
    turn,
    briefing: turnBriefing({
      intent,
      slots,
      filled: [...filledThisTurn, ...revisedThisTurn],
      question: asking,
      consented,
      ...(teamOffer === null ? {} : { boundary: teamOffer }),
      ...(closing === null ? {} : { closing: { summarized: prefix !== undefined } }),
      meeting: null,
      notUnderstood,
      ...(declining ? { declinedOffer: true } : {}),
      ...(waiting.closing === true ? { returning: true } : {}),
      ...(prefix === DETAILS_FIRST_SENTENCE ? { detailsFirst: true } : {}),
      ...(extraction.askedAboutCriteria ? { askedAboutCriteria: true } : {}),
      ...(reconfirmText === null ? {} : { reconfirmation: reconfirmText }),
      ...(brokerContext === undefined ? {} : { broker: brokerContext }),
      ...(search.searched
        ? { suggestions: { count: search.properties.length, relaxable: search.relaxable } }
        : lastSearch === null
          ? {}
          : { lastSearch }),
    }),
    question: asking,
    // On a search turn the script's question waits for the next one, but the
    // guard still has to tolerate a sentence that previews it.
    pendingSlot: search.searched ? (upcoming[0] ?? null) : (asking?.slot ?? null),
    nextSlot: upcoming[1] ?? null,
    allowedAmounts: [
      ...lead.amounts,
      ...(slots.priceMax === null ? [] : [slots.priceMax]),
      ...(slots.ticket === null ? [] : [slots.ticket]),
      // FR-012's allowed set is "what a search returned, plus what the lead
      // wrote" — these are the prices on the cards themselves.
      ...search.properties.map((property) => property.price),
    ],
    allowedPercentages: lead.percentages,
    // FR-032 again, for the written fallback: the search first.
    ...(search.searched
      ? {
          fallbackText:
            search.properties.length > 0 ? SUGGESTION_REPLY : noMatchReply(search.relaxable),
        }
      : reconfirmText !== null
        ? { fallbackText: reconfirmText }
        : teamOffer !== null
          ? { fallbackText: BOUNDARY_FALLBACK_SENTENCE }
          : closing !== null
            ? { fallbackText: closingSentence([], leadText, timezone, true) }
            : {}),
    ...(prefix === undefined ? {} : { prefix }),
    ...(teamOffer === null ? {} : { mustAsk: BOUNDARY_OFFER_QUESTION }),
    sink: context.sink,
    startedAt: context.startedAt,
  });

  const reply = phrased.chunks.join(" ").trim();
  // Which defence answered this turn, for the record (`visao-geral.md` §9): an
  // output guard names itself, and a steering attempt the structural layer
  // simply absorbed — no slot moved, no figure existed to quote — is recorded as
  // such, or SC-007 would have nothing to read afterwards.
  const guard = phrased.guard ?? (steering ? "steering" : null);

  return finish({
    turn,
    context,
    reply,
    intent,
    slots,
    filled: filledThisTurn,
    revised: revisedThisTurn,
    score,
    qualified,
    fallbackStreak,
    question,
    guard,
    handoffReason,
    meeting: null,
    reconfirmation: reconfirmText !== null,
    scheduling,
    toolCalls,
    propertyIds,
    propertyCodes: search.properties.map((property) => property.code),
    outcome: notUnderstood ? "fallback" : "replied",
  });
}
