/**
 * Layer 2 of `visao-geral.md` §9: a short list of patterns that gets a refusal
 * **without calling the model at all**.
 *
 * Short is the point. This is not a content filter and it cannot be one — it is
 * the cheap first pass over the three phrasings that are never anything but an
 * override attempt ("ignore suas instruções", "system prompt", "você agora é"),
 * so those cost no tokens and cannot depend on a 4-bit model choosing to obey.
 * Everything else is caught by the layers that do not rely on recognising a
 * phrase: the structure (the slot machine decides what is filled, the catalog
 * decides what a price is) and the output guards (`reply-guards.ts`).
 *
 * Widening this list would be the wrong instinct. A false positive here refuses
 * a real lead, and the other two layers hold whether or not a phrase was
 * recognised.
 *
 * Pure; imports nothing (constitution III).
 */

/** Accent-stripped lower case, so each pattern needs only one spelling. */
function normalize(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export const INJECTION_PATTERNS: ReadonlyArray<RegExp> = [
  // "ignore suas instruções", "ignora as instrucoes", "esqueça suas instruções"
  /\b(?:ignor|desconsider|esquec)\w*\s+(?:as\s+|suas\s+|essas\s+|todas\s+as\s+)?instru/,
  /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:your\s+|the\s+)?(?:previous\s+)?instructions\b/,
  // "system prompt", "prompt do sistema", "suas instruções de sistema"
  /\b(?:system|assistant|developer)\s+prompt\b/,
  /\bprompt\s+(?:do|de)\s+sistema\b/,
  // "você agora é", "a partir de agora você é"
  /\bvoce\s+agora\s+e\b/,
];

/** True when the lead's message is one of the phrasings above (FR-030). */
export function looksLikeInjection(text: string): boolean {
  const normalized = normalize(text);
  return INJECTION_PATTERNS.some((pattern) => pattern.test(normalized));
}
