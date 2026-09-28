import { tool } from "ai";
import { z } from "zod";
import {
  intentSchema,
  normalize,
  slotsSchema,
  type SlotExtraction,
  type SlotKey,
} from "../../domain/slots.ts";

/**
 * The one tool that changes qualification state — and it does not change it.
 *
 * `updateSlots` reports what the lead's message said. The merge is
 * `domain/slots.mergeSlots`, run by the orchestrator afterwards, which is what
 * makes "never overwrite a filled slot" and "the intent is immutable" properties
 * of the code rather than requests made of a 4-bit model (constitution V, FR-010).
 *
 * The advertised schema is derived from `slotsSchema` so there is one definition
 * of a slot, never two. What arrives back is `unknown` on purpose: this model
 * routinely answers `"comprar apartamento"` where an enum was asked for, and
 * `"zona sul"` where an array was. `normalizeExtraction` repairs the shapes that
 * are unambiguous and `mergeSlots` drops the rest — the same division of labour
 * as the reply guards.
 */

const DESCRIPTIONS: Record<SlotKey | "intent", string> = {
  intent:
    "purchase para comprar, rental para alugar, investment para investir. " +
    "Preencha só quando a pessoa disser o que ela quer fazer. Se a frase for uma " +
    'pergunta, ou começar com "se", "e se", "caso" ou "seria", ela está supondo, ' +
    "não decidindo: intent é null mesmo que as palavras comprar, alugar ou investir " +
    "apareçam. Se ela descreve uma busca real por imóvel sem dizer a finalidade, é purchase.",
  priceMax: "Orçamento máximo em reais, número inteiro. \"700 mil\" é 700000",
  bedrooms: "Número mínimo de quartos",
  neighborhoods: "Bairros ou regiões citados, separados por vírgula. Vazio = aberto a sugestões",
  urgency: "immediate até 3 meses, soon de 3 a 12 meses, exploring sem prazo",
  investorProfile: "firstTime se é a primeira aplicação em imóveis, experienced se já investe",
  ticket: "Valor do aporte em reais, número inteiro",
  returnExpectation: "income para renda de aluguel, appreciation para valorização, both, undecided",
  name: "Como a pessoa quer ser chamada",
  contact: "Telefone ou e-mail, exatamente como a pessoa escreveu",
};

/**
 * Every field optional and nullable: the model must be able to report one slot
 * without inventing the other eight, which is the failure this shape prevents.
 */
const field = <K extends SlotKey>(key: K) => slotsSchema.shape[key].nullish().describe(DESCRIPTIONS[key]);

/**
 * The fields the extraction asks for — the one definition of them.
 *
 * Deliberately *not* a JSON Schema handed to the provider. oMLX accepts a
 * `json_schema` response format and then fails to constrain the model to it:
 * measured over 96 calls, most answered with a bare `["zona sul"]` and ran to
 * the token ceiling, and at temperature 0 every single one did. Plain JSON mode
 * with these descriptions rendered into the prompt parsed 30 of 30 with no wrong
 * values, so this list feeds `extractionSystemPrompt` and nothing else sends a
 * schema anywhere.
 *
 * Types are therefore advisory: what comes back is whatever the model wrote, and
 * the repair stays where it already was — `normalizeExtraction` turns what the
 * model clearly meant into what the slot accepts, and `mergeSlots` drops the
 * rest. The model is asked for intent, never for a type.
 */
export interface ExtractionField {
  key: keyof Extracted;
  description: string;
  /** The closed set, when there is one — rendered into the prompt. */
  values?: readonly string[];
}

export const EXTRACTION_FIELDS: readonly ExtractionField[] = [
  { key: "intent", description: DESCRIPTIONS.intent, values: ["purchase", "rental", "investment"] },
  { key: "priceMax", description: DESCRIPTIONS.priceMax },
  { key: "bedrooms", description: DESCRIPTIONS.bedrooms },
  { key: "neighborhoods", description: DESCRIPTIONS.neighborhoods },
  { key: "urgency", description: DESCRIPTIONS.urgency, values: ["immediate", "soon", "exploring"] },
  {
    key: "investorProfile",
    description: DESCRIPTIONS.investorProfile,
    values: ["firstTime", "experienced"],
  },
  { key: "ticket", description: DESCRIPTIONS.ticket },
  {
    key: "returnExpectation",
    description: DESCRIPTIONS.returnExpectation,
    values: ["income", "appreciation", "both", "undecided"],
  },
  { key: "name", description: DESCRIPTIONS.name },
  { key: "contact", description: DESCRIPTIONS.contact },
  {
    key: "askedForHuman",
    description:
      "true SÓ se a pessoa pediu explicitamente para falar com um corretor, um humano, " +
      "uma pessoa de verdade ou um atendente. Reclamar, discordar, não entender ou mudar " +
      "de assunto NÃO é pedir. Escolher um horário, pedir horários ou querer marcar uma visita " +
      "ou conversa também NÃO é pedir, nem perguntar quem vai atender. Na dúvida, false.",
  },
  {
    key: "optOut",
    description:
      "true SÓ se a pessoa pediu para não receber mais mensagens, para sair ou para ser " +
      "removida do contato. Na dúvida, false.",
  },
  {
    key: "askedAboutCriteria",
    description:
      "true SÓ se a pessoa perguntou o que você está considerando, filtrando ou usando " +
      "como critério, OU perguntou sobre o resultado da busca: se tem imóvel, se tem mais " +
      "opções, se não achou nada. Na dúvida, false.",
  },
  {
    key: "attemptedAnswer",
    description:
      "true se a pessoa tentou comunicar algo: uma resposta, uma correção, uma pergunta, " +
      "um pedido ou uma informação. false se a mensagem não tenta informar nada — reação " +
      '("nossa", "haha"), cumprimento, agradecimento ("valeu"), checagem ("tá aí?") ou ' +
      "só um emoji. Na dúvida, false.",
  },
  // Spec 006. Facts about a meeting offer; code decides what each one does.
  {
    key: "declinedOffer",
    description:
      "true SÓ se a pessoa recusou ou adiou os horários que você acabou de oferecer " +
      '("agora não", "prefiro não marcar", "depois eu vejo"). Um "não" a outra pergunta NÃO ' +
      "é recusa. Na dúvida, false.",
  },
  {
    key: "askedForTimes",
    description:
      'true se a pessoa pediu horários, outros horários ("tem outro horário?", "só de manhã") ' +
      'ou disse que quer marcar uma visita ou uma conversa ("quero marcar uma visita"). Na dúvida, false.',
  },
  {
    key: "preferredWeekday",
    description: "O dia da semana que a pessoa pediu para o horário, se pediu um. Senão, null.",
    values: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
  },
  {
    key: "preferredPeriod",
    description: 'morning se a pessoa pediu de manhã, afternoon se pediu à tarde. Senão, null.',
    values: ["morning", "afternoon"],
  },
  {
    key: "pickedTime",
    description:
      'true se a pessoa escolheu um dos horários oferecidos ("a segunda", "pode ser a 1", ' +
      '"quinta às 10") ou disse um dia e uma hora para marcar. Na dúvida, false.',
  },
  {
    key: "propertyPosition",
    description:
      'Se a pessoa apontou um dos imóveis mostrados pela posição ("o segundo", "gostei do primeiro"), ' +
      "o número dessa posição, contando a partir de 1. Senão, null.",
  },
  {
    key: "meetingKind",
    description:
      "visit SÓ se, nesta mensagem, a pessoa pediu para visitar um imóvel pessoalmente; call SÓ se, nesta " +
      "mensagem, pediu uma conversa ou ligação por telefone. Uma visita ou conversa já marcada, citada numa " +
      "mensagem anterior, não conta. Senão, null.",
    values: ["visit", "call"],
  },
  {
    key: "unsupportedMeeting",
    description:
      "true se a pessoa pediu um encontro num formato que não é visita a um imóvel nem conversa por telefone: " +
      "reunião na imobiliária ou no escritório, videochamada (Google Meet, Zoom, FaceTime, vídeo no WhatsApp) " +
      "ou qualquer outro formato. Na dúvida, false.",
  },
  {
    key: "outOfScopeRequest",
    description:
      "true se a pessoa pediu algo ligado a uma visita que a imobiliária não faz: carona ou transporte, " +
      "reembolso de passagem ou combustível, escolher quem atende pela aparência, cor, gênero, religião, " +
      "ideologia ou outra característica pessoal. Perguntar quem vai atender NÃO é isso. Na dúvida, false.",
  },
  {
    key: "askedWhoAttends",
    description:
      'true se a pessoa perguntou quem vai atendê-la na visita ou conversa ("quem vai me atender?", ' +
      '"qual o nome do corretor?"). Na dúvida, false.',
  },
  {
    key: "propertyCode",
    description:
      'Se a pessoa citou o código de um imóvel, como "VMA-0005" ou "Interessado em MOE-0003", ' +
      "esse código, exatamente como escrito. Senão, null.",
  },
];

export interface Extracted {
  intent: string | null;
  priceMax: number | null;
  bedrooms: number | null;
  neighborhoods: string[] | null;
  urgency: string | null;
  investorProfile: string | null;
  ticket: number | null;
  returnExpectation: string | null;
  name: string | null;
  contact: string | null;
  askedForHuman: boolean;
  optOut: boolean;
  /** The lead tried to convey something, rather than reacting, greeting or checking in. */
  attemptedAnswer: boolean;
  askedAboutCriteria: boolean;
  declinedOffer: boolean;
  askedForTimes: boolean;
  preferredWeekday: string | null;
  preferredPeriod: string | null;
  pickedTime: boolean;
  propertyPosition: number | null;
  propertyCode: string | null;
  askedWhoAttends: boolean;
  meetingKind: string | null;
  unsupportedMeeting: boolean;
  outOfScopeRequest: boolean;
}

/** The model writes `true`, `"true"` or `"sim"`; all three mean the same thing. */
export function isTrue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  return ["true", "sim", "yes", "1"].includes(value.trim().toLowerCase());
}

export const updateSlotsInputSchema = z.object({
  intent: intentSchema.nullish().describe(DESCRIPTIONS.intent),
  priceMax: field("priceMax"),
  bedrooms: field("bedrooms"),
  neighborhoods: field("neighborhoods"),
  urgency: field("urgency"),
  investorProfile: field("investorProfile"),
  ticket: field("ticket"),
  returnExpectation: field("returnExpectation"),
  name: field("name"),
  contact: field("contact"),
});

// --- Repairing what the model got shaped wrong -------------------------------

const INTENT_WORDS: ReadonlyArray<readonly [string, "purchase" | "rental" | "investment"]> = [
  ["compr", "purchase"],
  ["adquir", "purchase"],
  ["purchase", "purchase"],
  ["alug", "rental"],
  ["loca", "rental"],
  ["rental", "rental"],
  ["rent", "rental"],
  ["invest", "investment"],
];

const URGENCY_WORDS: ReadonlyArray<readonly [string, string]> = [
  ["immediate", "immediate"],
  ["urgent", "immediate"],
  ["imediat", "immediate"],
  ["soon", "soon"],
  ["breve", "soon"],
  ["explor", "exploring"],
  ["pesquis", "exploring"],
];

const PROFILE_WORDS: ReadonlyArray<readonly [string, string]> = [
  ["firsttime", "firstTime"],
  ["first", "firstTime"],
  ["primeir", "firstTime"],
  ["experienc", "experienced"],
  ["experient", "experienced"],
];

const RETURN_WORDS: ReadonlyArray<readonly [string, string]> = [
  ["both", "both"],
  ["ambos", "both"],
  ["income", "income"],
  ["renda", "income"],
  ["aluguel", "income"],
  ["appreciation", "appreciation"],
  ["valoriza", "appreciation"],
  ["undecided", "undecided"],
  ["indecis", "undecided"],
];

function matchWord(value: unknown, table: ReadonlyArray<readonly [string, string]>): unknown {
  if (typeof value !== "string") return value;
  const text = normalize(value);
  for (const [needle, result] of table) {
    if (text.includes(needle)) return result;
  }
  return value;
}

const MAGNITUDES: ReadonlyArray<readonly [string, number]> = [
  ["milhao", 1_000_000],
  ["milhoes", 1_000_000],
  ["milh", 1_000_000],
  ["mil", 1_000],
];

/** `"700 mil"`, `"R$ 1.200.000"`, `"1,2 milhão"` — all of which this model sends. */
function toAmount(value: unknown): unknown {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;

  const text = normalize(value);
  const digits = text.match(/[\d.,]+/)?.[0];
  if (digits === undefined) return value;

  let base = digits;
  if (base.includes(",")) base = base.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(?:\.\d{3})+$/.test(base)) base = base.replace(/\./g, "");
  const parsed = Number(base.replace(/[.,]$/, ""));
  if (!Number.isFinite(parsed)) return value;

  for (const [needle, factor] of MAGNITUDES) {
    if (text.includes(needle)) return Math.round(parsed * factor);
  }
  return Math.round(parsed);
}

function toCount(value: unknown): unknown {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;
  const digits = value.match(/\d+/)?.[0];
  return digits === undefined ? value : Number(digits);
}

function toList(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item !== "");
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return [];
  return trimmed
    .split(/\s*(?:,|;|\/| e | ou )\s*/i)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/**
 * Shape repair, never invention: it turns a value the model clearly meant into
 * the value the schema accepts, and leaves anything ambiguous alone for
 * `mergeSlots` to drop (merge rule 4).
 */
export function normalizeExtraction(raw: unknown): SlotExtraction {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    // A model that means "not said" writes null, "", "n/a" or "null".
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      const text = value.trim();
      if (text === "" || ["null", "none", "n/a", "nao informado", "-"].includes(normalize(text))) {
        continue;
      }
    }

    switch (key) {
      case "intent":
        out.intent = matchWord(value, INTENT_WORDS);
        break;
      case "priceMax":
      case "ticket":
        out[key] = toAmount(value);
        break;
      case "bedrooms":
        out[key] = toCount(value);
        break;
      case "neighborhoods":
        out[key] = toList(value);
        break;
      case "urgency":
        out[key] = matchWord(value, URGENCY_WORDS);
        break;
      case "investorProfile":
        out[key] = matchWord(value, PROFILE_WORDS);
        break;
      case "returnExpectation":
        out[key] = matchWord(value, RETURN_WORDS);
        break;
      default:
        out[key] = value;
    }
  }

  return out as SlotExtraction;
}

/**
 * The tool as the model sees it. `execute` acknowledges and nothing else — the
 * orchestrator reads the call's raw arguments off the stream, because arguments
 * that fail the advertised schema never reach `execute` and those are exactly
 * the ones `normalizeExtraction` exists to save.
 */
export const updateSlots = tool({
  description:
    "Registra o que a última mensagem da pessoa informou sobre o que ela procura. " +
    "Use null para tudo que ela não disse.",
  inputSchema: updateSlotsInputSchema,
  execute: () => ({ ok: true }),
});
