import { z } from "zod";

/**
 * The slot machine: the deterministic core of the qualification (constitution V).
 *
 * The code decides what to ask next; the model only phrases it. This file is the
 * single code form of `modelo-de-dados.md` §2 — the script order, the slot schema
 * and the merge rules — and the `updateSlots` tool schema is derived from
 * `slotsSchema` rather than written a second time.
 *
 * Pure, and imports nothing but the schema library (constitution III).
 */

export const INTENTS = ["purchase", "rental", "investment", "undefined"] as const;
export type Intent = (typeof INTENTS)[number];

export const intentSchema = z.enum(INTENTS);

/**
 * `neighborhoods` is the one slot whose empty value is not `null`: an empty array
 * is the answer "aberto a sugestões" and counts as filled (merge rule 2), so
 * `null` has to mean "not answered yet".
 */
export const slotsSchema = z.object({
  priceMax: z.number().positive().nullable(),
  bedrooms: z.number().int().positive().nullable(),
  neighborhoods: z.array(z.string().min(1)).nullable(),
  urgency: z.enum(["immediate", "soon", "exploring"]).nullable(),
  investorProfile: z.enum(["firstTime", "experienced"]).nullable(),
  ticket: z.number().positive().nullable(),
  returnExpectation: z.enum(["income", "appreciation", "both", "undecided"]).nullable(),
  name: z.string().min(1).nullable(),
  contact: z.string().min(1).nullable(),
});

export type Slots = z.infer<typeof slotsSchema>;
export type SlotKey = keyof Slots;

/** `intent` is the first logical slot but lives on the lead, not in `Slots`. */
export type Askable = SlotKey | "intent";

export const EMPTY_SLOTS: Slots = Object.freeze({
  priceMax: null,
  bedrooms: null,
  neighborhoods: null,
  urgency: null,
  investorProfile: null,
  ticket: null,
  returnExpectation: null,
  name: null,
  contact: null,
});

/** Asked last, and only once consent is recorded (merge rule 5, FR-019). */
export const CONTACT_SLOTS = ["name", "contact"] as const;

/** `modelo-de-dados.md` §2. An undefined intent has no script — only the intent question. */
export const SCRIPT: Record<Intent, SlotKey[]> = {
  purchase: ["priceMax", "bedrooms", "neighborhoods", "urgency", "name", "contact"],
  rental: ["priceMax", "bedrooms", "neighborhoods", "urgency", "name", "contact"],
  investment: ["investorProfile", "ticket", "returnExpectation", "name", "contact"],
  undefined: [],
};

export const SLOT_KEYS = Object.keys(EMPTY_SLOTS) as SlotKey[];

/** pt-BR, one per askable. The fallback path says these verbatim; the model rephrases. */
export const QUESTIONS: Record<Askable, string> = {
  intent: "Você está procurando um imóvel para comprar, para alugar ou para investir?",
  priceMax: "Qual faixa de preço você tem em mente?",
  bedrooms: "Quantos quartos você precisa?",
  neighborhoods: "Tem algum bairro ou região específica em mente, ou aceita sugestões?",
  urgency: "Você precisa se mudar em breve ou ainda é uma pesquisa inicial?",
  investorProfile: "Essa seria sua primeira aplicação em imóveis ou você já investe no setor?",
  ticket: "Qual valor você pensa em destinar a esse investimento?",
  returnExpectation:
    "Sua expectativa é mais renda mensal com aluguel ou valorização no médio e longo prazo?",
  name: "Como posso te chamar?",
  contact: "Qual o melhor telefone ou e-mail para o corretor falar com você?",
};

/**
 * Words that mark a question as being about a given askable. Used by
 * `reply-guards.ts` to decide whether a second question refines the pending slot
 * or previews the next one — the only reason a reply may carry two (FR-012).
 * Matched on accent-stripped whole words, so "suite" finds "suíte".
 */
export const SLOT_TOPIC_WORDS: Record<Askable, readonly string[]> = {
  intent: ["comprar", "compra", "alugar", "aluguel", "investir", "investimento", "objetivo"],
  priceMax: ["preço", "preços", "valor", "orçamento", "faixa", "reais", "r$", "financiamento", "entrada"],
  bedrooms: ["quarto", "quartos", "dormitório", "dormitórios", "suíte", "suítes", "escritório"],
  neighborhoods: ["bairro", "bairros", "região", "regiões", "zona", "localização", "onde", "metrô", "trabalho"],
  urgency: ["prazo", "urgência", "urgente", "mudar", "mudança", "pressa", "quando", "breve", "entregar", "devolver"],
  investorProfile: ["investidor", "investidora", "experiência", "experiente", "perfil", "carteira", "primeira"],
  ticket: ["ticket", "aporte", "capital", "destinar", "valor", "reais", "r$"],
  returnExpectation: ["retorno", "renda", "valorização", "rentabilidade", "yield", "expectativa", "aluguel"],
  name: ["nome", "chamar", "chamo"],
  contact: ["telefone", "whatsapp", "whats", "zap", "e-mail", "email", "contato", "celular", "número", "fone"],
};

/**
 * The closed-set slots, and the words that count as the lead having raised them.
 *
 * These three are the ones a model invents. A number cannot be hallucinated into
 * a message that contains no number, but `urgency: "exploring"` can be assumed
 * about anyone — and it was: asked to read "quero comprar apartamento de 2
 * quartos na zona sul até 700 mil", the model filled a prazo the lead had not
 * mentioned, which skipped the question the script was about to ask. Prompting
 * against it halved the rate and did not remove it, so the structural layer
 * decides instead (constitution V).
 *
 * Only these three, and only because they are always spoken in words. A gate
 * like this over `priceMax` would throw away a perfectly good "até uns 700 mil",
 * which names no topic word at all.
 */
export const EVIDENCE_WORDS: Record<"intent" | "urgency" | "investorProfile" | "returnExpectation", readonly string[]> = {
  // A change of purpose must be said: "isso" or "Meu nome é Rafael" flipped a
  // renter or an investor into a buyer when the model echoed its default (30/09).
  intent: [
    ...SLOT_TOPIC_WORDS.intent,
    "compro", "comprando", "adquirir", "alugo", "alugando", "locacao", "locar",
    "invisto", "investindo", "renda", "rentabilidade", "retorno", "morar",
  ],
  urgency: [
    ...SLOT_TOPIC_WORDS.urgency,
    "mes", "meses", "semana", "semanas", "dia", "dias", "ano", "anos",
    "ja", "agora", "imediato", "imediata", "logo", "rapido", "correndo",
    "pesquisando", "olhando", "futuro", "calma", "sem pressa",
  ],
  investorProfile: [
    ...SLOT_TOPIC_WORDS.investorProfile,
    "investi", "investindo", "imoveis", "aplicacao", "aplicar", "iniciante", "veterano",
  ],
  returnExpectation: [
    ...SLOT_TOPIC_WORDS.returnExpectation,
    "alugar", "lucro", "ganho", "ganhar", "vender", "revenda", "longo prazo",
  ],
};

/**
 * Did the lead's own words raise this slot at all? Used to drop a closed-set
 * value the model supplied about a topic nobody mentioned.
 */
export function hasEvidence(slot: keyof typeof EVIDENCE_WORDS, text: string): boolean {
  const present = new Set(tokenize(text));
  const whole = normalize(text);
  return EVIDENCE_WORDS[slot].some((word) =>
    word.includes(" ") ? whole.includes(normalize(word)) : present.has(normalize(word)),
  );
}

/** Accent-stripped lower case, so the tables above need only one spelling. */
export function normalize(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/** Accent-stripped words. `R$` survives as one token, and `850.000` as another. */
export function tokenize(text: string): string[] {
  return normalize(text)
    .replace(/[^\p{Letter}\p{Number}$@.-]+/gu, " ")
    .split(" ")
    .map((word) => word.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((word) => word !== "");
}

/** The askables a sentence appears to be asking about; empty when nothing matches. */
export function questionTopics(sentence: string): Askable[] {
  const present = new Set(tokenize(sentence));
  const topics: Askable[] = [];
  for (const [askable, table] of Object.entries(SLOT_TOPIC_WORDS) as [Askable, readonly string[]][]) {
    if (table.some((word) => present.has(normalize(word)))) topics.push(askable);
  }
  return topics;
}

export function isFilled(slots: Slots, key: SlotKey): boolean {
  return slots[key] !== null && slots[key] !== undefined;
}

/** The script minus `name`/`contact` — what the score and `qualified` count. */
export function qualifyingSlots(intent: Intent): SlotKey[] {
  return SCRIPT[intent].filter((key) => !(CONTACT_SLOTS as readonly string[]).includes(key));
}

/** `modelo-de-dados.md` §3: every script slot filled except name and contact. */
export function isQualified(intent: Intent, slots: Slots): boolean {
  if (intent === "undefined") return false;
  return qualifyingSlots(intent).every((key) => isFilled(slots, key));
}

export interface QualificationState {
  intent: Intent;
  slots: Slots;
}

/**
 * What is still to be asked, in script order. `intent` comes first and alone while
 * the intent is undefined; `name` and `contact` disappear until consent is recorded.
 * An empty array means the script is finished — the moment to propose a meeting.
 */
export function upcomingSlots(state: QualificationState, consented: boolean): Askable[] {
  if (state.intent === "undefined") return ["intent"];
  return SCRIPT[state.intent].filter((key) => {
    if (isFilled(state.slots, key)) return false;
    if (!consented && (CONTACT_SLOTS as readonly string[]).includes(key)) return false;
    return true;
  });
}

export interface Question {
  slot: Askable;
  question: string;
}

/** The one question this turn asks, or null when there is nothing left to ask. */
export function nextQuestion(state: QualificationState, consented: boolean): Question | null {
  const [slot] = upcomingSlots(state, consented);
  return slot === undefined ? null : { slot, question: QUESTIONS[slot] };
}

export type SlotExtraction = Partial<Record<Askable, unknown>>;

export interface MergeResult {
  intent: Intent;
  slots: Slots;
  /** Slots that went empty → filled in this merge, in script order. */
  filled: SlotKey[];
  /** Slots that went value → different value, in script order. */
  revised: SlotKey[];
  /** The intent moved between two defined values. A first identification is not one. */
  intentChanged: boolean;
  /** Keys refused: an invalid value, an empty value over a filled slot, an
   *  unconsented contact slot, or a key that is not a slot at all. An intent
   *  change is no longer a refusal. */
  dropped: string[];
}

/** Same contents, including array order. A re-supplied identical value is not a revision. */
export function sameSlotValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => item === right[index]);
  }
  return Object.is(left, right);
}

/**
 * What changed between two slot states, in script order. A turn applies several
 * merges (extraction, then recovery); this is the comparison against the state
 * the turn started in, so a slot filled and then adjusted in the same turn stays
 * a fill.
 */
export function partitionSlotChanges(
  before: Slots,
  after: Slots,
): { filled: SlotKey[]; revised: SlotKey[] } {
  const filled: SlotKey[] = [];
  const revised: SlotKey[] = [];
  for (const key of SLOT_KEYS) {
    const had = isFilled(before, key);
    const has = isFilled(after, key);
    if (!had && has) filled.push(key);
    else if (had && has && !sameSlotValue(before[key], after[key])) revised.push(key);
  }
  return { filled, revised };
}

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined;
}

/**
 * The merge rules of `modelo-de-dados.md` §2, applied after every extraction.
 * Rule 3 is withdrawn (ADR 22): `intent` moving between two defined values is a
 * revision, reported as `intentChanged`, not a drop. An empty value still never
 * unfills a slot.
 *
 * `extraction` is `unknown` on purpose — it is model output.
 */
export function mergeSlots(
  current: QualificationState,
  extraction: unknown,
  options: { consented: boolean },
): MergeResult {
  const slots: Slots = { ...current.slots };
  let intent = current.intent;
  let intentChanged = false;
  const filled = new Set<SlotKey>();
  const revised = new Set<SlotKey>();
  const dropped: string[] = [];

  if (extraction === null || typeof extraction !== "object" || Array.isArray(extraction)) {
    return { intent, slots, filled: [], revised: [], intentChanged, dropped: [] };
  }

  const source = extraction as Record<string, unknown>;
  const unknownKeys: string[] = [];

  for (const key of ["intent", ...SLOT_KEYS] as Askable[]) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];

    // Intent moves out of `undefined` and between defined values. Re-supplying
    // the value it already holds is neither a change nor a drop.
    if (key === "intent") {
      const parsed = intentSchema.safeParse(value);
      if (!parsed.success || parsed.data === "undefined") {
        if (!isEmptyValue(value)) dropped.push("intent");
        continue;
      }
      if (parsed.data === current.intent) continue;
      if (current.intent !== "undefined") intentChanged = true;
      intent = parsed.data;
      continue;
    }

    const slot = key as SlotKey;

    // Rule 5: contact details do not exist before consent, whatever the model says.
    if (!options.consented && (CONTACT_SLOTS as readonly string[]).includes(slot)) {
      dropped.push(slot);
      continue;
    }

    // Rule 1: a filled slot is never replaced by an empty value. A *different*
    // non-empty value does replace it — a lead may raise their budget.
    if (isEmptyValue(value)) {
      if (isFilled(slots, slot)) dropped.push(slot);
      continue;
    }

    // Rule 4: an invalid value is dropped on its own; the rest still applies.
    const fieldSchema: z.ZodType<unknown> = slotsSchema.shape[slot];
    const parsed = fieldSchema.safeParse(value);
    if (!parsed.success) {
      dropped.push(slot);
      continue;
    }

    const wasEmpty = !isFilled(slots, slot);
    // Rule 2 falls out of the representation: `[]` is not an empty value here.
    // An identical value is not a fill and not a revision (US1 scenario 4).
    if (!wasEmpty && sameSlotValue(slots[slot], parsed.data)) continue;
    Object.assign(slots, { [slot]: parsed.data });
    if (wasEmpty) filled.add(slot);
    else revised.add(slot);
  }

  for (const name of Object.keys(source)) {
    if (name !== "intent" && !(SLOT_KEYS as string[]).includes(name)) unknownKeys.push(name);
  }

  return {
    intent,
    slots,
    filled: SLOT_KEYS.filter((key) => filled.has(key)),
    revised: SLOT_KEYS.filter((key) => revised.has(key)),
    intentChanged,
    dropped: [...dropped, ...unknownKeys],
  };
}
