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

/**
 * A wider read, used for a different purpose: **not** to refuse, only to stop a
 * refusal being counted as a misunderstanding.
 *
 * FR-027 hands the conversation to a person after two consecutive turns that
 * learned nothing, and an override attempt learns nothing by design — so five
 * scripted attempts in one session used to trip the fallback handoff on the
 * second one, which is the opposite of what SC-007 asks for: the agent had
 * understood every one of them and refused. Someone asking us to pretend, to
 * drop the script or to recite our instructions has been understood perfectly;
 * they are steering, not confusing us.
 *
 * A false positive here costs nothing but a missed fallback count, which is why
 * this list may be wide where `INJECTION_PATTERNS` must stay narrow: that one
 * ends a turn before the model runs, this one only declines to hold something
 * against the lead.
 */
const STEERING_PATTERNS: ReadonlyArray<RegExp> = [
  ...INJECTION_PATTERNS,
  /\bfinja\b|\bfaca de conta\b|\bfinge que\b|\bpretend\b/,
  /\baja como\b|\bse comporte como\b|\bassuma o papel\b/,
  /\bsem (?:regras|restricoes|limites|filtros)\b/,
  /\besque[çc]a\s+(?:o\s+)?(?:roteiro|script|tudo)\b/,
  /\b(?:repita|revele|mostre|diga)\b[^.?!]{0,40}\b(?:instru\w+|prompt|regras)\b/,
  /\bmodo desenvolvedor\b|\bdeveloper mode\b|\bjailbreak\b/,
];

/** True when the message is trying to steer the agent rather than answer it. */
export function looksLikeSteering(text: string): boolean {
  const normalized = normalize(text);
  return STEERING_PATTERNS.some((pattern) => pattern.test(normalized));
}
