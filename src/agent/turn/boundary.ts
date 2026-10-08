import { readAcknowledgement } from "../lexicon.ts";

/**
 * Spec 015 — what the agent can't resolve, decided in code.
 *
 * The extraction says what the message *does* (its act) and hands back the
 * part no other field captured (the remainder). When a request, question or
 * piece of information is left over and nothing in the turn handled it, the
 * agent offers — never pushes — to have someone from the team check it. The
 * model phrases the offer; this module only decides when there is one.
 */

export const MESSAGE_ACTS = ["thanks", "agree", "answer", "request", "question", "inform", "other"] as const;
export type MessageAct = (typeof MESSAGE_ACTS)[number];

/** The acts that can leave something the lead expects an answer to. */
const OPEN_ACTS: ReadonlySet<MessageAct> = new Set(["request", "question", "inform"]);

/** The longest remainder kept: enough for a sentence, not a transcript. */
const MAX_REMAINDER = 200;

export function readAct(value: unknown): MessageAct | null {
  if (typeof value !== "string") return null;
  const act = value.trim().toLowerCase();
  return (MESSAGE_ACTS as readonly string[]).includes(act) ? (act as MessageAct) : null;
}

export function readRemainder(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  if (text === "" || ["null", "none", "nada", "-", "n/a"].includes(text.toLowerCase())) return null;
  return text.length > MAX_REMAINDER ? `${text.slice(0, MAX_REMAINDER - 1)}…` : text;
}

/**
 * The act the turn goes by. A message that is only thanks or agreement is read
 * by code (`lexicon.readAcknowledgement`), whatever the model said — a "valeu!"
 * the model took for information must not become an offer to check it. The
 * other way round: a message that is more than that ("obrigado, e meu marido vai
 * junto") and left something over is information, whatever the model called it.
 */
export function settleAct(modelAct: MessageAct | null, leadText: string, remainder: string | null): MessageAct | null {
  const acknowledged = readAcknowledgement(leadText);
  if (acknowledged !== null) return acknowledged;
  if (remainder !== null && (modelAct === null || modelAct === "thanks" || modelAct === "agree" || modelAct === "other")) {
    return "inform";
  }
  return modelAct;
}

export interface BoundaryInput {
  act: MessageAct | null;
  remainder: string | null;
  /**
   * Nothing else in the turn answers the lead: no code-written reply, no
   * refusal, no handoff, no search to present, no criteria to recite. Only such
   * a turn — the script's question, "nothing to ask", or a close — gives way
   * to the offer (plan 015, "When the boundary applies").
   */
  phrasedTurn: boolean;
}

/** What the offer is about, or null when there is none this turn. */
export function boundaryOffer(input: BoundaryInput): { about: string } | null {
  if (!input.phrasedTurn || input.remainder === null) return null;
  if (input.act === null || !OPEN_ACTS.has(input.act)) return null;
  return { about: input.remainder };
}

/** What the lead did with an open offer: took it, turned it down, or moved on. */
export function offerOutcome(answer: "yes" | "no" | null): "handoff" | "close" | null {
  if (answer === "yes") return "handoff";
  if (answer === "no") return "close";
  return null;
}
