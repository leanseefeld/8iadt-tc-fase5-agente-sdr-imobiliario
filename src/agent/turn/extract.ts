import { generateText } from "ai";
import { getConfig } from "../../core/config.ts";
import { modelTelemetry, recordModelFailure } from "../../core/langfuse.ts";
import { createLogger } from "../../core/logging.ts";
import { hasEvidence, type Askable, type Intent, type SlotExtraction, type SlotKey } from "../../domain/slots.ts";
import type { CommittedToolCall, LoadedTurn } from "../../services/conversation.ts";
import { extractionSystemPrompt } from "../prompts/system.ts";
import { getJsonModel } from "../provider.ts";
import { isTrue, normalizeExtraction } from "../tools/update-slots.ts";
import { readAct, readRemainder, type MessageAct } from "./boundary.ts";
import { toModelMessages, unansweredText } from "./messages.ts";
import { NO_SCHEDULING, readSchedulingFacts, type SchedulingFacts } from "./read.ts";

/**
 * The turn's first model call: what the lead's message says, as the model read
 * it. Code settles it next (`read.ts`); nothing here decides anything.
 */

const log = createLogger("app", { module: "agent/turn/extract" });

export interface Extraction {
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
 * The output cap is the profile's own `extraction` ceiling. It was a fixed 300
 * until a reasoning model spent all 300 thinking (08/10/2026): the cap counts
 * reasoning tokens too, so only the profile knows what it must be.
 */

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
  currentIntent: Intent,
): { slots: SlotExtraction; dropped: SlotKey[] } {
  const kept: Record<string, unknown> = { ...extracted };
  const dropped: SlotKey[] = [];

  // The purpose, once known, changes only when the message says so. A first
  // identification needs no word of its own (a search with no purpose is a
  // purchase), but "isso" is not a change from renting to buying.
  if (
    kept.intent !== undefined &&
    currentIntent !== "undefined" &&
    kept.intent !== currentIntent &&
    pending !== "intent" &&
    !hasEvidence("intent", leadText)
  ) {
    log.info({ from: currentIntent, to: kept.intent }, "dropped an intent change the lead never said");
    delete kept.intent;
  }

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

export async function extract(turn: LoadedTurn, pending: Askable | null): Promise<Extraction> {
  const config = getConfig();

  for (let attempt = 1; attempt <= EXTRACTION_ATTEMPTS; attempt++) {
    try {
      const { text } = await generateText({
        model: getJsonModel(),
        ...modelTelemetry("model.extract"),
        maxRetries: config.MODEL_MAX_RETRIES,
        abortSignal: AbortSignal.timeout(config.MODEL_TIMEOUT_MS),
        maxOutputTokens: config.model.maxOutputTokens.extraction,
        system: extractionSystemPrompt(),
        messages: toModelMessages(turn, 4),
      });

      const object = parseExtraction(text);
      if (object === null) {
        log.warn({ attempt }, "extraction did not come back as an object");
        recordModelFailure("model.extract", `attempt ${attempt}: the answer was not a JSON object`);
        continue;
      }

      const gated = withoutInventedSlots(normalizeExtraction(object), unansweredText(turn), pending, turn.lead.intent);
      const extracted = gated.slots;
      const askedForHuman = isTrue(object.askedForHuman);
      const optedOut = isTrue(object.optOut);
      const attemptedAnswer = isTrue(object.attemptedAnswer);
      const askedAboutCriteria = isTrue(object.askedAboutCriteria);
      const scheduling = readSchedulingFacts(object);

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
        remainder: readRemainder(object.uncovered),
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
