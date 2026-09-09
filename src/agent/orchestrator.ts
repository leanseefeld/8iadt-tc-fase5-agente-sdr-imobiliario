import { streamText, type ModelMessage } from "ai";
import { getConfig } from "../core/config.ts";
import { createLogger } from "../core/logging.ts";
import { handoffDecision, shouldProposeMeeting, type HandoffReason } from "../domain/handoff.ts";
import { looksLikeInjection } from "../domain/injection.ts";
import { createReplyGuard, figuresIn, splitSentences } from "../domain/reply-guards.ts";
import { scoreLead } from "../domain/score.ts";
import {
  SLOT_KEYS,
  isQualified,
  mergeSlots,
  nextQuestion,
  qualifyingSlots,
  upcomingSlots,
  type Askable,
  type Intent,
  type Question,
  type SlotKey,
  type Slots,
} from "../domain/slots.ts";
import {
  claimTurn,
  commitTurn,
  loadTurn,
  releaseTurn,
  type CommittedToolCall,
  type LoadedTurn,
} from "../services/conversation.ts";
import {
  MODEL_FAILURE_REPLY,
  OPT_OUT_REPLY,
  PRE_CONSENT_REPLY,
  SUGGESTION_REPLY,
  guardedReply,
  noMatchReply,
  refusalReply,
} from "./prompts/fallback.ts";
import { extractionSystemPrompt, turnSystemPrompt } from "./prompts/system.ts";
import { modelCall } from "./provider.ts";
import { plausiblyAnswers, recoverSlot } from "./recovery.ts";
import { extractionTools, runProposeMeeting, runSearchProperties } from "./tools/index.ts";
import { normalizeExtraction } from "./tools/update-slots.ts";

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
  for (const message of turn.history) {
    if (message.role === "system") continue;
    const role = message.role === "lead" ? "user" : "assistant";
    const previous = messages.at(-1);
    if (previous !== undefined && previous.role === role) {
      previous.content = `${previous.content as string}\n${message.content}`;
      continue;
    }
    messages.push({ role, content: message.content });
  }

  const trimmed = limit === undefined ? messages : messages.slice(-limit);
  // A turn exists because a lead wrote; the model must end on their words.
  if (trimmed.at(-1)?.role !== "user") {
    trimmed.push({ role: "user", content: unansweredText(turn) });
  }
  return trimmed;
}

/** FR-044: one turn answers every lead message left unanswered, together. */
function unansweredText(turn: LoadedTurn): string {
  return turn.unanswered.map((message) => message.content).join("\n");
}

// ---------------------------------------------------------------------------
// 1 · Extraction
// ---------------------------------------------------------------------------

interface Extraction {
  /** Raw tool arguments, exactly as the model sent them. */
  calls: CommittedToolCall[];
  /** `requestHandoff` fired — spec 004's T043 registers the tool, this reads it. */
  leadAskedForHuman: boolean;
  optedOut: boolean;
  failed: boolean;
}

async function extract(turn: LoadedTurn, pending: Askable | null): Promise<Extraction> {
  const result: Extraction = { calls: [], leadAskedForHuman: false, optedOut: false, failed: false };

  try {
    const stream = streamText({
      ...modelCall(),
      system: extractionSystemPrompt(turn.lead.intent, turn.conversation.slots, pending),
      messages: toModelMessages(turn, 4),
      tools: extractionTools(),
      toolChoice: "required",
    });

    for await (const part of stream.fullStream) {
      if (part.type === "error") {
        result.failed = true;
        log.warn({ err: String(part.error) }, "extraction call failed");
        break;
      }
      if (part.type !== "tool-call") continue;
      result.calls.push({ name: part.toolName, arguments: part.input });
      if (part.toolName === "requestHandoff") result.leadAskedForHuman = true;
      if (part.toolName === "optOut") result.optedOut = true;
    }
  } catch (error) {
    result.failed = true;
    log.warn({ err: (error as Error).message }, "extraction call threw");
  }

  return result;
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
  system: string;
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
      system: input.system,
      messages: toModelMessages(input.turn),
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

  try {
    return await run(loaded, { ...options, sink, now, startedAt });
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
    await pauseBeforeFirstChunk(context.startedAt);
    const refusal = refusalReply(pending);
    context.sink.chunk(refusal);

    const refused = await commitTurn({
      turn,
      reply: refusal,
      intent: before.intent,
      slots: before.slots,
      filled: [],
      score: turn.lead.score,
      qualified: isQualified(before.intent, before.slots),
      // Not a misunderstanding: the message was understood perfectly well.
      fallbackStreak: turn.conversation.fallbackStreak,
      guard: "injectionInput",
      traceId: context.traceId ?? null,
      now: context.now,
    });
    context.sink.done();

    log.info({ conversationId: turn.conversation.id }, "input layer refused an override attempt");

    return {
      status: "committed",
      conversationId: turn.conversation.id,
      messageId: refused.messageId,
      repliesToMessageId: refused.repliesToMessageId,
      reply: refusal,
      intent: before.intent,
      slots: before.slots,
      filled: [],
      score: refused.score,
      qualified: isQualified(before.intent, before.slots),
      question: pending,
      guard: "injectionInput",
      handoffReason: null,
      meeting: null,
      propertyCodes: [],
      events: refused.events,
    };
  }

  // 1 · extract
  const extraction = await extract(turn, pending?.slot ?? null);
  const toolCalls: CommittedToolCall[] = [...extraction.calls];

  // 2 · merge, in code
  let merged = mergeSlots(before, {}, { consented });
  const filled = new Set<SlotKey>();
  for (const call of extraction.calls) {
    if (call.name !== "updateSlots") continue;
    const step = mergeSlots(merged, normalizeExtraction(call.arguments), { consented });
    merged = step;
    for (const slot of step.filled) filled.add(slot);
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
  const extractionSaidSomething = extraction.calls.some(
    (call) =>
      call.name === "updateSlots" &&
      Object.values(normalizeExtraction(call.arguments)).some(
        (value) => value !== null && value !== undefined,
      ),
  );

  if (stillPending && (pending.slot === "intent" || !extractionSaidSomething) && plausiblyAnswers(leadText)) {
    const recovered = await recoverSlot({ slot: pending.slot, text: leadText });
    if (Object.keys(recovered).length > 0) {
      toolCalls.push({ name: "recoverSlot", arguments: recovered });
      const step = mergeSlots(merged, recovered, { consented });
      merged = step;
      for (const slot of step.filled) filled.add(slot);
    }
  }

  // FR-029: someone who asked to be left alone is not qualified further, not
  // phrased at by a model and not asked one more question. The sentence is
  // written down (`OPT_OUT_REPLY`), the flag and the closed conversation are
  // `commitTurn`'s, and the turn ends here.
  if (extraction.optedOut) {
    await pauseBeforeFirstChunk(context.startedAt);
    context.sink.chunk(OPT_OUT_REPLY);

    const closed = await commitTurn({
      turn,
      reply: OPT_OUT_REPLY,
      intent: merged.intent,
      slots: merged.slots,
      filled: [],
      score: scoreLead(merged.intent, merged.slots),
      qualified: isQualified(merged.intent, merged.slots),
      fallbackStreak: 0,
      optedOut: true,
      toolCalls,
      traceId: context.traceId ?? null,
      now: context.now,
    });
    context.sink.done();

    return {
      status: "committed",
      conversationId: turn.conversation.id,
      messageId: closed.messageId,
      repliesToMessageId: closed.repliesToMessageId,
      reply: OPT_OUT_REPLY,
      intent: merged.intent,
      slots: merged.slots,
      filled: [],
      score: closed.score,
      qualified: isQualified(merged.intent, merged.slots),
      question: null,
      guard: null,
      handoffReason: null,
      meeting: null,
      propertyCodes: [],
      events: closed.events,
    };
  }

  // 3 · compute — every decision below is made here, never by the model
  const { intent, slots } = merged;
  const filledThisTurn = SLOT_KEYS.filter((slot) => filled.has(slot));
  const learnedSomething = filledThisTurn.length > 0 || intent !== before.intent;
  const score = scoreLead(intent, slots);
  const qualified = isQualified(intent, slots);

  // A reaction to the cards ("gostei do segundo") fills no slot and is not a
  // misunderstanding — counting it as one would walk a happy conversation into
  // a handoff two turns after the catalog answered.
  const lastAgentMessage = [...turn.history].reverse().find((message) => message.role === "agent");
  const cardsJustShown =
    Array.isArray(lastAgentMessage?.metadata.propertyIds) &&
    (lastAgentMessage.metadata.propertyIds as unknown[]).length > 0;

  // FR-023/FR-027: a turn that read a real message and learned nothing is a
  // fallback, and two in a row are a handoff.
  const notUnderstood = !learnedSomething && plausiblyAnswers(leadText) && !cardsJustShown;
  const fallbackStreak = notUnderstood ? turn.conversation.fallbackStreak + 1 : 0;
  const handoffReason = handoffDecision({
    leadAskedForHuman: extraction.leadAskedForHuman,
    fallbackStreak,
  });

  // FR-040/041: the offer is a decision of the slot machine, not of the model.
  const meeting = handoffReason === null ? shouldProposeMeeting(intent, slots, score) : null;
  if (meeting !== null) {
    const offered = runProposeMeeting();
    toolCalls.push({ name: "proposeMeeting", arguments: { kind: meeting, status: offered.status } });
  }

  const question = meeting !== null || handoffReason !== null ? null : nextQuestion({ intent, slots }, consented);
  const upcoming = upcomingSlots({ intent, slots }, consented);

  // FR-024/026: the catalog is asked exactly once, on the turn that completes the
  // qualifying script — `mergeSlots` never overwrites a filled slot, so those
  // filters cannot change afterwards and a second search would return the same
  // three rows under a second set of cards. `runSearchProperties` refuses
  // `investment` on its own (FR-041), and a handoff or a meeting turn has a
  // different job.
  const searchDue =
    qualified &&
    handoffReason === null &&
    meeting === null &&
    filledThisTurn.some((slot) => qualifyingSlots(intent).includes(slot));

  const search = searchDue
    ? await runSearchProperties({ agencyId: turn.agency.id, intent, slots })
    : { properties: [], searched: false, relaxable: null };

  if (search.searched) {
    toolCalls.push({
      name: "searchProperties",
      arguments: { codes: search.properties.map((property) => property.code) },
    });
  }
  const propertyIds = search.properties.map((property) => property.id);

  // 4 · phrase
  const lead = figuresIn(`${leadText} ${turn.history.map((m) => m.content).join(" ")}`);
  const phrased = await phrase({
    turn,
    system: turnSystemPrompt({
      intent,
      slots,
      filled: filledThisTurn,
      question,
      consented,
      meeting,
      notUnderstood,
      handoff: handoffReason !== null,
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
    ...(search.searched
      ? {
          fallbackText:
            search.properties.length > 0 ? SUGGESTION_REPLY : noMatchReply(search.relaxable),
        }
      : {}),
    sink: context.sink,
    startedAt: context.startedAt,
  });

  const reply = phrased.chunks.join(" ").trim();

  const committed = await commitTurn({
    turn,
    reply,
    intent,
    slots,
    filled: filledThisTurn,
    score,
    qualified,
    fallbackStreak,
    handoffReason,
    ...(propertyIds.length > 0 ? { propertyIds } : {}),
    guard: phrased.guard,
    toolCalls,
    traceId: context.traceId ?? null,
    now: context.now,
  });

  context.sink.done();

  return {
    status: "committed",
    conversationId: turn.conversation.id,
    messageId: committed.messageId,
    repliesToMessageId: committed.repliesToMessageId,
    reply,
    intent,
    slots,
    filled: filledThisTurn,
    score,
    qualified,
    question,
    guard: phrased.guard,
    handoffReason,
    meeting,
    propertyCodes: search.properties.map((property) => property.code),
    events: committed.events,
  };
}
