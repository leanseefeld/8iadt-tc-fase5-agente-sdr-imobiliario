import { generateObject } from "ai";
import { z } from "zod";
import { getConfig } from "../core/config.ts";
import { createLogger } from "../core/logging.ts";
import {
  QUESTIONS,
  intentSchema,
  slotsSchema,
  tokenize,
  type Askable,
  type SlotExtraction,
} from "../domain/slots.ts";
import { SLOT_HINTS } from "./prompts/system.ts";
import { getModel } from "./provider.ts";
import { normalizeExtraction } from "./tools/update-slots.ts";

/**
 * The second chance at one slot (FR-011).
 *
 * ADR 14's premise, confirmed on this model: a 4-bit model asked to call a tool
 * *and* write a reply will sometimes do only one of them. When the lead plainly
 * answered the pending question and no usable extraction came back, guessing is
 * not an option and re-asking is rude — so one bounded structured call is made
 * for that single slot, with a schema of exactly one field.
 *
 * It is deliberately narrow. It never sees the other slots, never sets more than
 * one, and its failure is silent: the slot stays empty, the agent re-asks in
 * other words and the fallback streak moves — the path the spec's clarification
 * chose over inventing a value.
 */

const log = createLogger("app", { module: "agent/recovery" });

/** Anything shorter than this is a greeting or a reaction, not an answer. */
const NOISE = new Set([
  "oi", "ola", "opa", "eai", "hey", "hi", "bom", "boa", "dia", "tarde", "noite",
  "ok", "okay", "blz", "beleza", "obrigado", "obrigada", "valeu", "sim", "nao",
  "kk", "kkk", "haha", "hmm", "hm", "eh", "ah", "uhum",
]);

/**
 * FR-011's "plausibly answered it". A message made only of greetings, reactions
 * or emoji is the spec's "noise instead of an answer" edge case and must not
 * cost a model call.
 */
export function plausiblyAnswers(text: string): boolean {
  const words = tokenize(text);
  if (words.length === 0) return false;
  return words.some((word) => !NOISE.has(word) && word.length > 1);
}

function schemaFor(slot: Askable): z.ZodType<unknown> {
  if (slot === "intent") return intentSchema.nullable();
  return slotsSchema.shape[slot].nullable();
}

export interface RecoveryInput {
  slot: Askable;
  /** The lead's message, or the unanswered messages joined — what to read. */
  text: string;
}

/**
 * One `generateObject` for one slot. Returns an extraction with at most that one
 * key, ready for `mergeSlots`, or an empty extraction when the model refused,
 * timed out or answered with something the schema rejected.
 */
export async function recoverSlot(input: RecoveryInput): Promise<SlotExtraction> {
  const config = getConfig();
  const schema = z.object({ [input.slot]: schemaFor(input.slot) });

  try {
    const result = await generateObject({
      model: getModel(),
      maxRetries: config.MODEL_MAX_RETRIES,
      // `generateObject` is the one call that does not take `timeout` — its
      // options are `Omit<RequestOptions, 'timeout'>` — so the same bound of
      // FR-014 is applied as an abort signal instead.
      abortSignal: AbortSignal.timeout(config.MODEL_TIMEOUT_MS),
      maxOutputTokens: config.MODEL_MAX_OUTPUT_TOKENS,
      schema,
      schemaName: "resposta",
      schemaDescription: SLOT_HINTS[input.slot],
      system:
        "Você extrai um único dado de uma mensagem em português. Responda null se a " +
        "mensagem não responder à pergunta. Não invente, não complete, não explique.\n" +
        `Como ler ${input.slot}: ${SLOT_HINTS[input.slot]}`,
      prompt: `Pergunta feita: "${QUESTIONS[input.slot]}"\nResposta da pessoa: "${input.text}"`,
    });

    return normalizeExtraction(result.object);
  } catch (error) {
    // FR-011 is one bounded attempt. A failed one is not an error for the turn:
    // the slot simply stays empty and the agent says it did not understand.
    log.warn({ slot: input.slot, err: (error as Error).message }, "slot recovery failed");
    return {};
  }
}
