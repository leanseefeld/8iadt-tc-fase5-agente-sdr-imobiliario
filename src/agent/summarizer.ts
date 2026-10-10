import { generateText } from "ai";
import { modelTelemetry, recordModelFailure, rememberLeadName } from "../core/langfuse.ts";
import { createLogger } from "../core/logging.ts";
import { modelCall } from "./provider.ts";

/**
 * The broker's summary — the one model call in this system that no lead ever
 * waits for (FR-015).
 *
 * It is written **for a broker who has not read the conversation**, which is a
 * different job from the agent's: no voice, no greeting, no question. Four
 * facts, in a register a person can scan between two phone calls, plus one
 * sentence short enough for a table cell.
 *
 * The model is given the previous summary and only the messages since it
 * (FR-011), so a long conversation costs the same as a short one and the
 * summary accumulates rather than being rewritten from scratch each sweep.
 */

const log = createLogger("worker", { module: "agent/summarizer" });

/** One retry, for a call that throws or an answer that does not parse. */
const SUMMARY_ATTEMPTS = 2;

/** FR-012. The preview line's limit is enforced in code, below, not trusted. */
export const PREVIEW_LINE_MAX_CHARS = 90;

/**
 * Asked for JSON in text rather than through `generateObject`, for the reason
 * spec 004 found and wrote down: on `gemma-4-e4b-it-OptiQ-4bit` a two-field
 * structured call fails validation often — two of the three seeded conversations
 * came back as "response did not match schema" — while the same model writes
 * perfectly good JSON into a text response. So the object is parsed here, with
 * the first balanced object winning, exactly as the extraction does.
 */
function parseSummary(text: string): { summary?: unknown; previewLine?: unknown } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as { summary?: unknown; previewLine?: unknown };
  } catch {
    return null;
  }
}

/** The first sentence of the summary, when the model gave no preview line. */
function firstSentence(summary: string): string {
  const match = /^.*?[.!?](\s|$)/.exec(summary.trim());
  return (match?.[0] ?? summary).trim();
}

export interface SummaryInput {
  previousSummary: string | null;
  messages: { role: "lead" | "agent" | "broker"; content: string }[];
  /** Registered for redaction before the call, never sent as a field. */
  leadName?: string | null;
}

export interface Summary {
  summary: string;
  previewLine: string;
}

const SYSTEM = [
  "Você escreve resumos internos de conversas de uma imobiliária, para um corretor",
  "que ainda não leu a conversa. Escreva em português do Brasil.",
  "",
  'Responda APENAS com um objeto JSON: {"summary": "...", "previewLine": "..."}.',
  "Sem texto antes ou depois, sem crase, sem markdown.",
  "",
  "Os dois campos:",
  "- summary: de duas a quatro frases dizendo o que a pessoa quer, as restrições",
  "  dela, a urgência e qual é o próximo passo. Sem saudação, sem comentário sobre",
  "  o resumo, sem emoji.",
  '- previewLine: UMA frase curta, no máximo 90 caracteres, no tom de "Contrato de',
  '  aluguel vence em 6 semanas". É o que aparece numa lista, então diga a coisa',
  "  mais útil que se sabe sobre esta pessoa.",
  "",
  "Não invente nada que a conversa não diga. Se algo não foi dito, omita.",
].join("\n");

/**
 * Trimmed of the quotes a model likes to add, then cut at the last word
 * boundary that fits. A hard slice would end mid-word in a table cell, and an
 * ellipsis is cheaper than a retry on a 4-bit model that will do this often.
 */
export function truncatePreviewLine(raw: string, max = PREVIEW_LINE_MAX_CHARS): string {
  const cleaned = raw
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length <= max) return cleaned;

  const cut = cleaned.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const body = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:!?-]+$/, "");
  return `${body}…`;
}

function transcript(input: SummaryInput): string {
  const speaker = { lead: "Pessoa", agent: "Agente", broker: "Corretor" } as const;
  return input.messages.map((message) => `${speaker[message.role]}: ${message.content}`).join("\n");
}

/**
 * Throws when both attempts fail. The caller (`jobs/summarize.ts`) decides what that
 * means — and its answer is to keep the summary it already had, because a stale
 * summary is never load-bearing and a poison pill would cost a model call every
 * sweep forever.
 */
export async function summarizeConversation(input: SummaryInput): Promise<Summary> {
  // The name is in the messages about to be sent, so it has to be redactable
  // before the span is exported (principle VIII).
  rememberLeadName(input.leadName);

  const previous =
    input.previousSummary === null
      ? "Ainda não há resumo anterior."
      : `Resumo anterior:\n${input.previousSummary}`;

  // One retry, as the extraction does: an answer that does not parse is the
  // sampler's fault and usually does not repeat. A second failure throws, and
  // the consumer's existing path takes over (FR-016).
  let rawSummary = "";
  let parsed: ReturnType<typeof parseSummary> = null;
  for (let attempt = 1; attempt <= SUMMARY_ATTEMPTS && rawSummary === ""; attempt++) {
    let text: string;
    try {
      ({ text } = await generateText({
        ...modelCall(),
        ...modelTelemetry("summary.generate"),
        system: SYSTEM,
        prompt: `${previous}\n\nMensagens novas:\n${transcript(input)}`,
      }));
    } catch (error) {
      log.warn({ err: (error as Error).message, attempt }, "summary call failed");
      if (attempt === SUMMARY_ATTEMPTS) throw error;
      continue;
    }
    parsed = parseSummary(text);
    rawSummary = typeof parsed?.summary === "string" ? parsed.summary.trim() : "";
    if (rawSummary === "") {
      log.warn({ attempt }, "summary did not parse");
      recordModelFailure("summary.generate", `attempt ${attempt}: no summary in the answer`);
    }
  }
  if (rawSummary === "") {
    throw new Error("the model returned no summary");
  }

  const summary = rawSummary;
  // A missing preview line is repaired rather than thrown away: the first
  // sentence of a good summary is a usable list row, and one field arriving
  // malformed is not a reason to spend the call again.
  const rawPreview =
    typeof parsed?.previewLine === "string" && parsed.previewLine.trim() !== ""
      ? parsed.previewLine
      : firstSentence(summary);
  const previewLine = truncatePreviewLine(rawPreview);

  log.debug({ chars: summary.length, previewChars: previewLine.length }, "summary generated");
  return { summary, previewLine };
}
