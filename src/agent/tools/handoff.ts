import { tool } from "ai";
import { z } from "zod";
import { HANDOFF_REASONS, type HandoffReason } from "../../domain/handoff.ts";

/**
 * The lead asking for a person, in the one form the turn can act on.
 *
 * The tool *reports*; it decides nothing. `domain/handoff.handoffDecision` is
 * what turns "the lead asked" plus "two fallbacks in a row" into a reason, and
 * `commitTurn` is what pauses the conversation — so a model that calls this tool
 * out of nowhere changes no state on its own beyond the reason recorded, and a
 * model that never calls it still hands over on the fallback streak the code
 * counts (FR-027, constitution V).
 *
 * `reason` exists because the same handoff has two origins and 005's inbox has
 * to tell them apart. The model only ever supplies `asked`; `fallback` is
 * computed.
 */

export interface HandoffRequest {
  ok: true;
  reason: HandoffReason;
}

export const requestHandoff = tool({
  description:
    "Registra que a pessoa pediu para falar com um corretor de verdade, um humano ou um " +
    "atendente. Chame apenas quando ela pedir isso explicitamente.",
  inputSchema: z.object({
    reason: z
      .enum(HANDOFF_REASONS)
      .nullish()
      .describe("asked quando a pessoa pediu uma pessoa; nunca use fallback"),
  }),
  execute: ({ reason }): HandoffRequest => ({ ok: true, reason: reason ?? "asked" }),
});
