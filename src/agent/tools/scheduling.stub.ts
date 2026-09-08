import { tool } from "ai";
import { z } from "zod";

/**
 * The scheduling tools, declared and inert.
 *
 * `modelo-de-dados.md` §6 fixes the two signatures so spec 006 fills these in by
 * editing this file and `index.ts`, and nothing else (FR-009). They are declared
 * now rather than later because the turn already reaches the moment that calls
 * them: FR-040's hot lead with a contact, and FR-041's finished investment
 * script. What is missing is a broker's agenda, not the decision to offer.
 *
 * Both return a result the reply can be built on, so the lead hears "um
 * especialista vai te chamar" rather than an apology — the offer is real, only
 * the calendar is not here yet.
 */

export interface SchedulingResult {
  ok: boolean;
  /** Read by the orchestrator, and by the prompt through it. */
  status: "notAvailable";
  message: string;
}

const NOT_AVAILABLE: SchedulingResult = {
  ok: false,
  status: "notAvailable",
  message: "A agenda ainda não está ligada. Combine o retorno sem confirmar horário.",
};

/**
 * The tool's body, callable without a tool runtime. FR-040/041 are deterministic
 * conditions, so the orchestrator invokes this directly rather than hoping the
 * model picks the tool; the tool below is the same body, for when the model does.
 */
export function runProposeMeeting(): SchedulingResult {
  return NOT_AVAILABLE;
}

/** §6: `proposeMeeting()` — no arguments. The kind is decided in code (ADR 19). */
export const proposeMeeting = tool({
  description:
    "Oferece uma visita ou uma conversa com um especialista. Chame quando o roteiro terminar.",
  inputSchema: z.object({}),
  execute: runProposeMeeting,
});

/** §6: `bookMeeting({ optionIndex } | { scheduledAt })`. */
export const bookMeeting = tool({
  description: "Confirma um horário já oferecido. Ainda não disponível nesta versão.",
  inputSchema: z.object({
    optionIndex: z.number().int().nonnegative().nullish(),
    scheduledAt: z.string().nullish(),
  }),
  execute: (): SchedulingResult => NOT_AVAILABLE,
});
