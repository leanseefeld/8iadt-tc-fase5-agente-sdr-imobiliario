import type { HandoffReason } from "../../domain/handoff.ts";
import type { Question } from "../../domain/slots.ts";

/**
 * Every sentence the lead can read that no model wrote.
 *
 * Four of them exist because a model call must not happen at all — the consent
 * template (FR-019), the budget and length notices (FR-032). The rest exist
 * because a model call happened and its result cannot be used: it timed out, it
 * came back empty, or a reply guard threw it away (FR-012, FR-014). Keeping them
 * in one file is what makes the tone consistent across the paths a lead only
 * meets when something has gone wrong.
 *
 * pt-BR, written to pass `domain/reply-guards.ts` itself: one question at most,
 * no figure, no tool word.
 */

/** The widget's first bubble, rendered locally and never generated (FR-018). */
export const CONSENT_NOTICE =
  "Oi! Sou a Sofia, consultora da imobiliária. Para te ajudar a encontrar um imóvel, " +
  "vou guardar o que você me contar aqui — o que procura e, mais para frente, seu nome e " +
  "contato — e compartilhar com o corretor que vai te atender. Tudo bem para você?";

/** FR-019: text typed before "Aceito". No model call, nothing persisted. */
export const PRE_CONSENT_REPLY =
  "Antes de começarmos, preciso do seu aceite no aviso acima. É só tocar em \"Aceito\" " +
  "e eu sigo daqui.";

/** FR-032: the per-session budget tripped. */
export const BUDGET_REPLY =
  "Recebi bastante coisa em pouco tempo por aqui. Vou pedir para um corretor assumir a " +
  "conversa e te responder direitinho, tudo bem?";

/** FR-032: a single message over `CHAT_MAX_MESSAGE_CHARS`. */
export const TOO_LONG_REPLY =
  "Sua mensagem ficou grande demais para eu ler de uma vez. Consegue me contar o " +
  "principal em poucas linhas?";

/** FR-014: the provider timed out, errored, or came back empty. */
export const MODEL_FAILURE_REPLY =
  "Desculpa, tive um probleminha aqui e não consegui responder agora. Pode me mandar de " +
  "novo em instantes?";

/**
 * FR-025: the cards are already on the screen, so the sentence that introduces
 * them says nothing the lead can read off the card itself. Used when a guard
 * throws the model's own version away.
 */
export const SUGGESTION_REPLY =
  "Separei algumas opções que combinam com o que você me contou. Qual delas te interessou mais?";

/** FR-025: nothing matched, and exactly one filter is offered for relaxing. */
const RELAX_QUESTIONS: Record<"neighborhoods" | "priceMax" | "bedrooms", string> = {
  neighborhoods: "Posso procurar em bairros vizinhos também?",
  priceMax: "Você toparia esticar um pouco o valor?",
  bedrooms: "Você consideraria um imóvel com um quarto a menos?",
};

export function noMatchReply(relaxable: "neighborhoods" | "priceMax" | "bedrooms" | null): string {
  const apology = "Não encontrei nenhum imóvel com exatamente essas características agora.";
  return relaxable === null ? apology : `${apology} ${RELAX_QUESTIONS[relaxable]}`;
}

/** FR-029: opt-out, confirmed in one sentence. */
export const OPT_OUT_REPLY =
  "Combinado, não vou mais te escrever por aqui. Obrigada pelo seu tempo!";

/** FR-028: the conversation is going to a person. */
export function handoffReply(reason: HandoffReason): string {
  return reason === "asked"
    ? "Claro, já estou chamando um corretor para continuar com você. É só escrever por aqui " +
        "mesmo que ele responde."
    : "Acho que não estou conseguindo te entender direito, e você merece uma resposta melhor. " +
        "Vou chamar um corretor para assumir daqui.";
}

/**
 * FR-023: say so rather than guess. The pending question comes back verbatim from
 * `domain/slots.ts`, so the re-ask is the same question in the script's own words.
 */
export function notUnderstoodReply(question: Question | null): string {
  const apology = "Desculpa, não peguei bem o que você quis dizer.";
  return question === null ? apology : `${apology} ${question.question}`;
}

/**
 * The reply the lead gets when a guard rejected what the model wrote. The script
 * still has to move, so the deterministic question is sent on its own — a turn
 * that says nothing would be worse than a turn that sounds like a form.
 */
export function guardedReply(question: Question | null): string {
  return question === null
    ? "Perfeito, anotado! Já vou passar isso para o corretor que vai te atender."
    : `Perfeito, anotado! ${question.question}`;
}
