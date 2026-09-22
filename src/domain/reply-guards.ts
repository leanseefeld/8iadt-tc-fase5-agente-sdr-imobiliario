import { normalize, questionTopics, tokenize, type Askable } from "./slots.ts";

/**
 * The output layer of `visao-geral.md` §9's three-layer defence, as pure functions.
 *
 * FR-012: a reply must not reach the lead if it is not in Portuguese, carries more
 * than two questions or a second question that refines nothing, states a figure no
 * search returned, or exposes tool syntax. Each case is repaired or replaced in
 * code — none of it is left to the prompt, because a 4-bit model will not obey a
 * prompt reliably enough to be a control.
 *
 * The unit is the sentence, because that is the unit the orchestrator streams: a
 * chunk is checked before the lead ever sees it.
 */

export type GuardName = "leakedSyntax" | "language" | "unbackedFigure" | "questionCount";

export interface GuardContext {
  /** The question this turn was supposed to ask. */
  pendingSlot: Askable | null;
  /** The script's slot after it — the only other thing a second question may cover. */
  nextSlot: Askable | null;
  /** BRL figures this turn's search returned, plus figures the lead itself stated. */
  allowedAmounts: readonly number[];
  allowedPercentages: readonly number[];
}

export type GuardVerdict = { ok: true } | { ok: false; guard: GuardName; reason: string };

const OK: GuardVerdict = { ok: true };

function reject(guard: GuardName, reason: string): GuardVerdict {
  return { ok: false, guard, reason };
}

// --- 1 · Leaked tool syntax, system text and internal state ------------------

const LEAK_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/<\/?\s*tool[_-]?call/i, "a tool call tag"],
  [/<\|[^|]*\|>/, "a chat template token"],
  [/\btool[_ ]?calls?\b/i, "the words tool call"],
  [/"(?:name|arguments|parameters|function|tool_name)"\s*:/i, "raw JSON arguments"],
  [/\b(?:system|assistant|developer)\s+prompt\b/i, "a mention of the system prompt"],
  [/^\s*(?:system|assistant|user)\s*:/im, "a role prefix"],
  [/\bchat_template(?:_kwargs)?\b/i, "a chat template field"],
  [/\breasoning_content\b/i, "the reasoning channel"],
  [/\b(?:updateSlots|searchProperties|requestHandoff|optOut|proposeMeeting|bookMeeting)\b/, "a tool name"],
  [/```/, "a code fence"],
  [/\bfunctions?\.\w+/i, "a function reference"],
];

function checkLeakedSyntax(sentence: string): GuardVerdict {
  for (const [pattern, description] of LEAK_PATTERNS) {
    if (pattern.test(sentence)) return reject("leakedSyntax", `the reply exposes ${description}`);
  }
  return OK;
}

// --- 2 · Portuguese, by stopword ratio ---------------------------------------

/**
 * Stopwords, accent-stripped. Words that exist in both languages ("a", "as",
 * "no", "me", "do", "so") are in neither list — an ambiguous hit is worse than
 * a missing one, because this guard replaces a reply the lead never sees.
 */
const PORTUGUESE_STOPWORDS = new Set([
  "o", "os", "um", "uma", "uns", "umas", "de", "da", "das", "dos", "em", "na", "nas", "nos",
  "para", "pra", "por", "pelo", "pela", "com", "sem", "que", "qual", "quais", "quantos",
  "quantas", "voce", "voces", "seu", "sua", "seus", "suas", "e", "ou", "mas", "se", "sao",
  "tem", "temos", "esta", "estou", "estao", "mais", "menos", "ja", "nao", "sim", "muito",
  "bem", "entao", "isso", "isto", "esse", "essa", "este", "esta", "aqui", "te", "lhe", "nos",
  "eu", "ele", "ela", "eles", "elas", "tambem", "sobre", "entre", "ate", "quando", "onde",
  "como", "porque", "algum", "alguma", "todos", "todas", "ao", "aos", "meu", "minha",
  "posso", "pode", "quero", "quer", "vamos", "vou", "faz", "fica", "ser", "foi", "era",
  "acho", "sei", "obrigado", "obrigada", "otimo", "otima", "perfeito", "certo",
]);

const ENGLISH_STOPWORDS = new Set([
  "the", "an", "of", "in", "on", "at", "to", "for", "with", "and", "or", "but", "is", "are",
  "was", "were", "be", "been", "being", "you", "your", "yours", "i", "we", "they", "he",
  "she", "it", "its", "this", "that", "these", "those", "what", "which", "who", "how",
  "when", "where", "why", "can", "could", "would", "should", "will", "shall", "does", "did",
  "have", "has", "had", "there", "here", "from", "about", "into", "than", "then", "some",
  "any", "all", "my", "us", "them", "his", "her", "him", "our", "their", "please", "thanks",
]);

/** Below this, a sentence is too short to judge — "Perfeito!" is not English. */
const MIN_WORDS_TO_JUDGE = 4;
/** At this length, no Portuguese stopword at all is itself the evidence. */
const MIN_WORDS_WITHOUT_PORTUGUESE = 6;

function checkLanguage(sentence: string): GuardVerdict {
  const words = tokenize(sentence);
  if (words.length < MIN_WORDS_TO_JUDGE) return OK;

  let portuguese = 0;
  let english = 0;
  for (const word of words) {
    if (PORTUGUESE_STOPWORDS.has(word)) portuguese += 1;
    if (ENGLISH_STOPWORDS.has(word)) english += 1;
  }

  if (english > portuguese) return reject("language", "the reply reads as English, not Portuguese");
  if (portuguese === 0 && words.length >= MIN_WORDS_WITHOUT_PORTUGUESE) {
    return reject("language", "the reply carries no Portuguese function word");
  }
  return OK;
}

// --- 3 · Money and percentages no search backed ------------------------------

const MAGNITUDES: Record<string, number> = {
  mil: 1_000,
  milhao: 1_000_000,
  milhoes: 1_000_000,
  mi: 1_000_000,
  reais: 1,
};

/** `R$ 850.000`, `1,2 milhão` — Brazilian grouping, so a dot is not a decimal point. */
function parseBrazilianNumber(raw: string): number | null {
  let text = raw.replace(/\s+/g, "").replace(/[.,]+$/, "");
  if (text.includes(",")) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(?:\.\d{3})+$/.test(text)) {
    text = text.replace(/\./g, "");
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** A cent of slack, so a figure written back in a different form still matches. */
function isAllowed(value: number, allowed: readonly number[]): boolean {
  return allowed.some((candidate) => Math.abs(candidate - value) < 0.01);
}

const CURRENCY_PREFIXED = /r\$\s*([\d.,]+)\s*(mil|milhao|milhoes|mi)?/g;
const MAGNITUDE_SUFFIXED = /(?<![\d.,])([\d.,]+)\s*(mil|milhao|milhoes|mi|reais)\b/g;
const PERCENTAGE = /(?<![\d.,])([\d.,]+)\s*(?:%|por cento)/g;

function amountsIn(normalized: string): number[] {
  const amounts: number[] = [];
  for (const pattern of [CURRENCY_PREFIXED, MAGNITUDE_SUFFIXED]) {
    pattern.lastIndex = 0;
    for (const match of normalized.matchAll(pattern)) {
      const value = parseBrazilianNumber(match[1]);
      if (value === null) continue;
      amounts.push(value * (MAGNITUDES[match[2] ?? ""] ?? 1));
    }
  }
  return amounts;
}

function percentagesIn(normalized: string): number[] {
  const percentages: number[] = [];
  PERCENTAGE.lastIndex = 0;
  for (const match of normalized.matchAll(PERCENTAGE)) {
    const value = parseBrazilianNumber(match[1]);
    if (value !== null) percentages.push(value);
  }
  return percentages;
}

/**
 * Every money amount and percentage a piece of text states, in the same forms
 * the guard reads them back. The orchestrator uses it on the lead's own messages
 * to build `allowedAmounts`: a figure the lead wrote is a figure the agent may
 * repeat, and the whole guard turns on that distinction.
 */
export function figuresIn(text: string): { amounts: number[]; percentages: number[] } {
  const normalized = normalize(text);
  return { amounts: amountsIn(normalized), percentages: percentagesIn(normalized) };
}

function checkFigures(sentence: string, context: GuardContext): GuardVerdict {
  const normalized = normalize(sentence);

  for (const amount of amountsIn(normalized)) {
    if (!isAllowed(amount, context.allowedAmounts)) {
      return reject("unbackedFigure", `no search returned the amount ${amount}`);
    }
  }
  for (const percentage of percentagesIn(normalized)) {
    if (!isAllowed(percentage, context.allowedPercentages)) {
      return reject("unbackedFigure", `no search returned the percentage ${percentage}`);
    }
  }
  return OK;
}

// --- 4 · One question, or two when the second refines the first --------------

const MAX_QUESTIONS = 2;

function secondQuestionIsAllowed(sentence: string, context: GuardContext): boolean {
  const permitted = [context.pendingSlot, context.nextSlot].filter((slot) => slot !== null);
  if (permitted.length === 0) return false;
  const topics = questionTopics(sentence);
  return topics.some((topic) => permitted.includes(topic));
}

// --- The guard itself --------------------------------------------------------

/**
 * Sentence boundaries, aware that a dot between digits is a thousands separator
 * and not a full stop — `R$ 850.000` is one sentence, not three.
 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== "." && character !== "!" && character !== "?") continue;
    if (character === "." && /\d/.test(text[index - 1] ?? "") && /\d/.test(text[index + 1] ?? "")) {
      continue;
    }

    let end = index + 1;
    while (end < text.length && ".!?".includes(text[end])) end += 1;
    const following = text[end];
    if (following !== undefined && !/\s/.test(following)) continue;

    const sentence = text.slice(start, end).trim();
    if (sentence !== "") sentences.push(sentence);
    start = end;
    index = end - 1;
  }

  const tail = text.slice(start).trim();
  if (tail !== "") sentences.push(tail);
  return sentences;
}

/**
 * The streaming form. The question count is per reply, not per chunk, so the
 * guard carries that one piece of state across the chunks of a single turn.
 */
export function createReplyGuard(context: GuardContext): { check(chunk: string): GuardVerdict } {
  let questionsSoFar = 0;

  return {
    check(chunk: string): GuardVerdict {
      for (const sentence of splitSentences(chunk)) {
        const leaked = checkLeakedSyntax(sentence);
        if (!leaked.ok) return leaked;

        const language = checkLanguage(sentence);
        if (!language.ok) return language;

        const figures = checkFigures(sentence, context);
        if (!figures.ok) return figures;

        if (!sentence.includes("?")) continue;
        questionsSoFar += 1;

        if (questionsSoFar > MAX_QUESTIONS) {
          return reject("questionCount", "the reply asks more than two questions");
        }
        if (questionsSoFar === MAX_QUESTIONS && !secondQuestionIsAllowed(sentence, context)) {
          return reject(
            "questionCount",
            "the second question might not refine the pending slot nor ask the next one",
          );
        }
      }
      return OK;
    },
  };
}

/** The whole-reply form, for the fallback path and for the tests. */
export function checkReply(reply: string, context: GuardContext): GuardVerdict {
  return createReplyGuard(context).check(reply);
}
