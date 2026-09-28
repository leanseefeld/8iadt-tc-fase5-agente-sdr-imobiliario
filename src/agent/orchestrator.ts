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
  claimTurn,
  commitTurn,
  lastTurnWasReconfirmation,
  loadTurn,
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
import { actionTools, runProposeMeeting, type SearchOutcome } from "./tools/index.ts";
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
  /** Closed-set slots the evidence gate refused — understood, but not trusted. */
  dropped: SlotKey[];
  failed: boolean;
}

const NOTHING: Extraction = {
  calls: [],
  leadAskedForHuman: false,
  optedOut: false,
  saidSomething: false,
  attemptedAnswer: false,
  askedAboutCriteria: false,
  dropped: [],
  failed: true,
};

/**
 * The three-state streak (FR-003, FR-003d). Learning resets it. A conversational
 * turn and a failed extraction hold it. An attempt the system could not use
 * advances it. A dropped slot also holds, because it was understood.
 */
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
     * Ignored. It used to keep a steering attempt off the streak. That shield
     * is gone (FR-026); the call site still records the attempt as a guard.
     */
    steering?: boolean;
  },
): { notUnderstood: boolean; fallbackStreak: number } {
  // The steering shield is gone. Callers still pass the flag so the call site
  // shows the attempt was recognised; the count does not read it.
  void turn.steering;
  if (turn.learnedSomething) return { notUnderstood: false, fallbackStreak: 0 };
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
      const askedForHuman = isTrue(object.askedForHuman);
      const optedOut = isTrue(object.optOut);
      const attemptedAnswer = isTrue(object.attemptedAnswer);
      const askedAboutCriteria = isTrue(object.askedAboutCriteria);

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
        dropped: gated.dropped,
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
function drain(buffer: string, final: boolean): { ready: string[]; rest: string } {
  const sentences = splitSentences(buffer);
  if (sentences.length === 0) return { ready: [], rest: final ? "" : buffer };
  if (final || /[.!?]["')\]]?\s*$/.test(buffer)) return { ready: sentences, rest: "" };
  return { ready: sentences.slice(0, -1), rest: sentences.at(-1) as string };
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
  const recoveryDue =
    stillPending &&
    (pending.slot === "intent" || !extraction.saidSomething) &&
    plausiblyAnswers(leadText);

  if (recoveryDue) {
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
  });
  const notUnderstood = accounted.notUnderstood;
  const fallbackStreak = accounted.fallbackStreak;
  const handoffReason = handoffDecision({
    leadAskedForHuman: extraction.leadAskedForHuman,
    fallbackStreak,
  });

  // FR-040/041: the offer is a decision of the slot machine, not of the model.
  const meeting =
    handoffReason === null
      ? shouldProposeMeeting(intent, slots, score, offerOutstanding(turn))
      : null;
  if (meeting !== null) {
    const offered = runProposeMeeting();
    toolCalls.push({ name: "proposeMeeting", arguments: { kind: meeting, status: offered.status } });
  }

  const question = meeting !== null || handoffReason !== null ? null : nextQuestion({ intent, slots }, consented);
  const upcoming = upcomingSlots({ intent, slots }, consented);

  // A search-relevant criterion was filled or revised, and the script is far
  // enough along to search. This only decides whether `act()` is offered.
  // `investment` is refused inside the tool (FR-041), and a handoff or a
  // meeting turn has a different job.
  const searchRelevant = [...filledThisTurn, ...revisedThisTurn];
  const searchDue =
    qualified &&
    handoffReason === null &&
    meeting === null &&
    searchRelevant.some((slot) => qualifyingSlots(intent).includes(slot));

  // `searchDue` only decides whether the action call is offered. The search
  // itself runs inside the loop, as a model tool call, and may run again
  // before any reply exists (FR-013).
  const searches: SearchOutcome[] = [];
  if (searchDue) {
    const acted = await act({
      turn,
      briefing:
        "Há uma busca a considerar com os critérios já registrados. Chame searchProperties.",
      tools: actionTools({
        agencyId: turn.agency.id,
        intent,
        slots,
        onOutcome: (outcome) => {
          searches.push(outcome);
        },
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
      handoffReason === "fallback" && leadText.includes("?")
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
  // than replacing the offer the lead was about to hear.
  const reconfirmKeys =
    meeting !== null
      ? []
      : reconfirmationKeys(
          { revised: revisedThisTurn, intentChanged },
          slots,
          lastTurnWasReconfirmation(turn),
        );
  const reconfirmText = reconfirmationSentence(slots, reconfirmKeys);

  // A question this agent cannot act on yet still counts toward a handoff,
  // and the reply says so instead of claiming the message was not understood.
  if (notUnderstood && leadText.includes("?") && meeting === null && reconfirmText === null) {
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
      meeting,
      toolCalls,
      propertyIds,
      propertyCodes: search.properties.map((property) => property.code),
      outcome: handoffReason !== null ? "handoff" : "fallback",
    });
  }

  const phrased = await phrase({
    turn,
    briefing: turnBriefing({
      intent,
      slots,
      filled: [...filledThisTurn, ...revisedThisTurn],
      question,
      consented,
      meeting,
      notUnderstood,
      ...(extraction.askedAboutCriteria ? { askedAboutCriteria: true } : {}),
      ...(reconfirmText === null ? {} : { reconfirmation: reconfirmText }),
      ...(brokerContext === undefined ? {} : { broker: brokerContext }),
      ...(search.searched
        ? { suggestions: { count: search.properties.length, relaxable: search.relaxable } }
        : {}),
    }),
    question,
    // On a search turn the script's question waits for the next one, but the
    // guard still has to tolerate a sentence that previews it.
    pendingSlot: search.searched ? (upcoming[0] ?? null) : (question?.slot ?? null),
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
    ...(reconfirmText !== null
      ? { fallbackText: reconfirmText }
      : search.searched
        ? {
            fallbackText:
              search.properties.length > 0 ? SUGGESTION_REPLY : noMatchReply(search.relaxable),
          }
        : {}),
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
    meeting,
    reconfirmation: reconfirmText !== null,
    toolCalls,
    propertyIds,
    propertyCodes: search.properties.map((property) => property.code),
    outcome: meeting !== null ? "meeting_proposed" : notUnderstood ? "fallback" : "replied",
  });
}
