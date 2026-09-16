import { tool } from "ai";
import { z } from "zod";

/**
 * "Não quero mais receber mensagens" — the one thing a lead can ask for that
 * ends the conversation (FR-029).
 *
 * No arguments: there is nothing to qualify about a refusal, and an argument
 * would only be one more thing a 4-bit model could get wrong. Like
 * `requestHandoff` this only reports; `commitTurn` sets `doNotContact` and
 * closes the conversation, and `prompts/fallback.OPT_OUT_REPLY` is the sentence
 * that goes out — written, not generated, because the last thing someone reads
 * from us should not depend on a sampler.
 */

export const optOut = tool({
  description:
    "Registra que a pessoa não quer mais receber mensagens, quer sair, cancelar ou ser " +
    "removida do contato. Chame apenas quando ela pedir isso explicitamente.",
  inputSchema: z.object({}),
  execute: () => ({ ok: true as const }),
});
