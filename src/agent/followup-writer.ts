import { generateText } from "ai";
import { modelTelemetry, rememberLeadName } from "../core/langfuse.ts";
import { createLogger } from "../core/logging.ts";
import { INTENTS, nextQuestion, type Intent } from "../domain/slots.ts";
import { readSlots } from "../services/conversation.ts";
import { modelCall } from "./provider.ts";

/**
 * The follow-up message (spec 006 FR-014): one opening sentence the model
 * writes, naming a concrete detail of what the lead is looking for, and the
 * pending question, which code appends verbatim.
 *
 * Split that way for the same reason the options are code-written: the part
 * that must be exact is not the model's to get wrong. "Ends with the pending
 * question" holds by construction; the opening is checked — no question of its
 * own, no date or hour (options go stale while a lead is quiet), no name of
 * anyone on the team (the summary is written for brokers and may carry one,
 * FR-005e) — and replaced by a code-written one when it fails.
 *
 * The input is the stored summary and the slot state, never the transcript.
 */

const log = createLogger("worker", { module: "agent/followup-writer" });

export interface FollowupInput {
  intent: string;
  slots: Record<string, unknown>;
  summary: string | null;
  leadName: string | null;
  /** An appointment is still `proposed`: the question invites the lead back to it, without times. */
  proposalOpen: boolean;
  /** The agency's team, first names included, that the opening must not mention. */
  teamNames: string[];
}

export interface FollowupMessage {
  text: string;
  /** Whether the model's opening was used, or the code-written one replaced it. */
  opening: "model" | "fallback";
}

const PROPOSAL_QUESTION = "Ainda quer marcar a visita? Se quiser, te passo horários atualizados.";
const OPEN_QUESTION = "Posso te ajudar com mais alguma coisa na sua busca?";

/** The question left hanging, in the slot machine's own words. */
export function pendingQuestion(input: Pick<FollowupInput, "intent" | "slots" | "proposalOpen">): string {
  if (input.proposalOpen) return PROPOSAL_QUESTION;
  const intent: Intent = (INTENTS as readonly string[]).includes(input.intent) ? (input.intent as Intent) : "undefined";
  // Consented: a lead is only followed up after the consent that opened the conversation.
  return nextQuestion({ intent, slots: readSlots(input.slots) }, true)?.question ?? OPEN_QUESTION;
}

function money(value: number): string {
  if (value >= 1_000_000) {
    const millions = (value / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
    return `R$ ${millions} ${value >= 2_000_000 ? "milhões" : "milhão"}`;
  }
  // Rents are exact: "R$ 3.500", never a rounded "R$ 4 mil" the lead didn't say.
  if (value < 10_000) return `R$ ${value.toLocaleString("pt-BR")}`;
  return `R$ ${(value / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil`;
}

/** "de 2 quartos em Moema, até R$ 700 mil" — whatever the slots know, in that order. */
export function searchDetail(slots: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof slots.bedrooms === "number") parts.push(`de ${slots.bedrooms} ${slots.bedrooms === 1 ? "quarto" : "quartos"}`);
  if (Array.isArray(slots.neighborhoods) && slots.neighborhoods.length > 0) {
    parts.push(`em ${(slots.neighborhoods as string[]).join(", ")}`);
  }
  const detail = parts.join(" ");
  const price = typeof slots.priceMax === "number" ? `até ${money(slots.priceMax)}` : "";
  return [detail, price].filter((part) => part !== "").join(", ");
}

/** FR-014's floor: never generic, even when the model failed the checks. */
export function fallbackOpening(input: Pick<FollowupInput, "slots" | "leadName" | "intent">): string {
  const hello = input.leadName ? `Oi, ${input.leadName.trim().split(/\s+/)[0]}!` : "Oi!";
  const detail = searchDetail(input.slots);
  if (input.intent === "investment") return `${hello} Passando para retomar a conversa sobre o seu investimento em imóveis.`;
  const what = input.intent === "rental" ? "aluguel" : "imóvel";
  return detail === ""
    ? `${hello} Passando para retomar a conversa sobre o ${what} que você procura.`
    : `${hello} Passando para retomar a busca pelo ${what} ${detail}.`;
}

const TIME = /\b\d{1,2}\s?(h\b|h\d{2}|:\d{2})|\b\d{1,2}\/\d{1,2}\b/i;
const WEEKDAY = /\b(segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo)(-feira)?\b/i;

/** Why an opening is unusable, or `null`. Exported for the tests. */
export function openingProblem(opening: string, teamNames: string[]): string | null {
  const text = opening.trim();
  if (text === "") return "empty";
  if (text.length > 240) return "too_long";
  if (text.includes("?")) return "question";
  // "Oi, [Nome da pessoa]!" — a template the model filled with its own slot names.
  if (/[[\]{}<>]/.test(text)) return "placeholder";
  if (TIME.test(text) || WEEKDAY.test(text)) return "date_or_time";
  const lower = text.toLowerCase();
  for (const name of teamNames) {
    for (const part of name.toLowerCase().split(/\s+/)) {
      if (part.length >= 3 && new RegExp(`\\b${part}\\b`, "i").test(lower)) return "team_name";
    }
  }
  return null;
}

const SYSTEM = [
  "Você é Sofia, assistente virtual de uma imobiliária, e vai retomar uma conversa que ficou parada.",
  "Escreva UMA frase curta, em português do Brasil, falando diretamente com a pessoa (você), para reabrir a conversa.",
  "Comece cumprimentando a pessoa pelo nome, se ele foi informado; se não, só \"Oi!\". Cite um detalhe concreto do que ela procura",
  "(bairro, número de quartos, faixa de preço).",
  "Regras: não faça pergunta; não cite datas, dias da semana nem horários; não cite o nome de ninguém da equipe;",
  "não fale da pessoa em terceira pessoa; no máximo um emoji. Responda só com a frase, sem aspas.",
  'Exemplo de tom: "Oi, Marcos! Passando para retomar sua busca por uma casa de 3 quartos em Pinheiros, até R$ 1,5 milhão."',
].join("\n");

/**
 * Throws when the model cannot be reached: the caller leaves the attempt
 * retryable, with no count consumed (FR-013). A reachable model that writes an
 * unusable opening is not a failure — the code-written opening replaces it.
 */
export async function writeFollowup(input: FollowupInput): Promise<FollowupMessage> {
  rememberLeadName(input.leadName);
  const question = pendingQuestion(input);
  const facts = [
    input.leadName ? `Nome da pessoa: ${input.leadName}` : null,
    `Objetivo: ${input.intent}`,
    `O que ela procura: ${searchDetail(input.slots) || "ainda pouco definido"}`,
    input.summary ? `Resumo da conversa: ${input.summary}` : null,
  ].filter((line): line is string => line !== null);

  const result = await generateText({
    ...modelCall(),
    ...modelTelemetry("followup.write"),
    system: SYSTEM,
    prompt: facts.join("\n"),
  });

  const opening = result.text.trim().replace(/^["'“”]+|["'“”]+$/g, "").split("\n")[0].trim();
  const problem = openingProblem(opening, input.teamNames);
  if (problem !== null) {
    log.info({ problem }, "follow-up opening replaced by the code-written one");
    return { text: `${fallbackOpening(input)} ${question}`, opening: "fallback" };
  }
  return { text: `${opening} ${question}`, opening: "model" };
}
