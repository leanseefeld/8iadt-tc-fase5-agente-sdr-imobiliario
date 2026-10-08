import { streamText } from "ai";
import { modelTelemetry } from "../../core/langfuse.ts";
import { createLogger } from "../../core/logging.ts";
import { createReplyGuard, splitSentences } from "../../domain/reply-guards.ts";
import type { Askable, Question } from "../../domain/slots.ts";
import type { LoadedTurn } from "../../services/conversation.ts";
import { MODEL_FAILURE_REPLY, guardedReply } from "../prompts/fallback.ts";
import { REPLY_SYSTEM_PROMPT } from "../prompts/system.ts";
import { modelCall } from "../provider.ts";
import { briefed, toModelMessages } from "./messages.ts";
import { pauseBeforeFirstChunk, type ReplySink } from "./sink.ts";

/**
 * The turn's last model call: the reply, streamed sentence by sentence, each
 * sentence through the output guards before the lead sees it. Everything it
 * says was decided before it starts; it has no tools on purpose — given a tool
 * and asked for a sentence, this model picks the tool.
 */

const log = createLogger("app", { module: "agent/turn/phrase" });

export interface PhrasedReply {
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

export interface PhraseInput {
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
   * The turn's task forbids a question (nothing to ask, a close). A sentence
   * that asks one anyway is dropped, not sent: the model was told and asked
   * regardless ("Você gostaria de marcar…?" over options already on screen).
   */
  noQuestions?: boolean;
  /**
   * Spec 015: a question the reply must end up asking. When the phrased reply
   * doesn't ask anything, it goes out after it — an offer the lead can't see is
   * no offer, and a "sim" to nothing would still hand the conversation off.
   */
  mustAsk?: string;
  sink: ReplySink;
  startedAt: number;
}

export async function phrase(input: PhraseInput): Promise<PhrasedReply> {
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
        if (input.noQuestions === true && sentence.includes("?")) {
          log.info("dropped a question the turn's task forbids");
          continue;
        }
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
        if (input.noQuestions === true && sentence.includes("?")) continue;
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
