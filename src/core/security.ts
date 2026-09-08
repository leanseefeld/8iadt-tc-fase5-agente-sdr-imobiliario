/**
 * The one masking rule, constitution principle VIII / FR-031: personal data is
 * masked in log records and in Langfuse traces by a single shared definition,
 * not a rule re-implemented per sink. `src/core/logging.ts` (T012) and the
 * Langfuse span exporter both call `maskPII` on whatever they are about to
 * write; the event payloads described in `docs/arquitetura/modelo-de-dados.md`
 * do the same before they hit `events`. This file is the only place any of
 * them may define what "masked" means.
 *
 * The PII surface is small and known: `leads.name`, `leads.phone`,
 * `leads.email`, and the slot values `name` and `contact` (a phone OR an
 * e-mail) — plus free text, since a lead can type a phone number into a
 * message body that was never meant to carry one.
 *
 * Two entry points. `maskText` handles a single string — used directly, and
 * as the fallback for any string `maskPII` does not recognise as sensitive.
 * `maskPII` walks an arbitrary structure (a log record, a span payload, an
 * event payload) key-aware, so a `leadName` field is masked as a name even
 * though its content alone would not say so.
 *
 * Never throws. Telemetry must never break the caller that is trying to log
 * something (constitution IX) — a masking bug should degrade to "unmasked",
 * caught elsewhere, not to a crash.
 */

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

const EMAIL_LOCAL = "[a-zA-Z0-9][a-zA-Z0-9._%+-]*";
const EMAIL_DOMAIN = "[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\\.[a-zA-Z]{2,}";
const EMAIL_SOURCE = `(${EMAIL_LOCAL})@(${EMAIL_DOMAIN})`;

const EMAIL_PATTERN = new RegExp(EMAIL_SOURCE, "g");
const EMAIL_PATTERN_FULL = new RegExp(`^\\s*${EMAIL_SOURCE}\\s*$`);

function maskEmailMatch(local: string, domain: string): string {
  return `${local[0]}***@${domain}`;
}

/** `value` must be nothing but one e-mail (surrounding whitespace aside). */
function maskEmailValue(value: string): string | null {
  const match = EMAIL_PATTERN_FULL.exec(value);
  if (!match) return null;
  return maskEmailMatch(match[1], match[2]);
}

// ---------------------------------------------------------------------------
// Brazilian phone number
// ---------------------------------------------------------------------------

/**
 * Matches the four documented forms — `11987654321`, `(11) 98765-4321`,
 * `+55 11 98765-4321`, `11 98765 4321` — and nothing shaped like a price, a
 * year or a CEP. The digit budget is what does the filtering: two area-code
 * digits plus a 4-or-5 digit block plus a 4-digit block sums to exactly 10 or
 * 11, and only to 12 or 13 when the literal `55` country-code prefix is also
 * present. A CEP's 3+3 split and a `R$`-price's dotted thousands groups never
 * add up to that, so they fall through untouched. The digit lookaround keeps
 * this from matching the middle of a longer run (a UUID segment, an ID).
 */
const PHONE_SOURCE =
  "(?<!\\d)(?:\\+?55[\\s-]?)?\\(?\\d{2}\\)?[\\s.-]?\\d{4,5}[\\s.-]?\\d{4}(?!\\d)";

const PHONE_PATTERN = new RegExp(PHONE_SOURCE, "g");
const PHONE_PATTERN_FULL = new RegExp(`^\\s*${PHONE_SOURCE}\\s*$`);

function onlyDigits(value: string): string {
  return value.replace(/\D/g, "");
}

/** Strips a leading `55` country code, if the digit count says it is one. */
function localDigits(digits: string): string | null {
  const local =
    (digits.length === 12 || digits.length === 13) && digits.startsWith("55")
      ? digits.slice(2)
      : digits;
  return local.length === 10 || local.length === 11 ? local : null;
}

/**
 * First two digits and last two survive; everything between is starred. The
 * dash lands where a real number's would (4-4 split at 10 digits, 5-4 at 11),
 * and parens always frame the area code — one shape for every input shape,
 * so the mask never gives away whether the lead typed `(11)` or `+55`.
 */
function formatMaskedPhone(local: string): string {
  const area = local.slice(0, 2);
  const last = local.slice(-2);
  const middle = local.slice(2, -2);
  const stars = "*".repeat(middle.length);
  const dashAt = local.length === 11 ? 5 : 4;
  return `(${area}) ${stars.slice(0, dashAt)}-${stars.slice(dashAt)}${last}`;
}

function maskPhoneMatch(rawMatch: string): string {
  const local = localDigits(onlyDigits(rawMatch));
  // Defensive: PHONE_SOURCE's digit budget already guarantees a valid count.
  return local ? formatMaskedPhone(local) : rawMatch;
}

/** `value` must be nothing but one phone number (surrounding whitespace aside). */
function maskPhoneValue(value: string): string | null {
  const match = PHONE_PATTERN_FULL.exec(value);
  if (!match) return null;
  return maskPhoneMatch(match[0]);
}

// ---------------------------------------------------------------------------
// Free text
// ---------------------------------------------------------------------------

/** Partially masks one string: keeps the shape, loses the identity. */
export function maskText(text: string): string {
  try {
    return text
      .replace(EMAIL_PATTERN, (_match, local: string, domain: string) =>
        maskEmailMatch(local, domain),
      )
      .replace(PHONE_PATTERN, (match) => maskPhoneMatch(match));
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Each word keeps its first letter; the rest is one flat `***`, not a
 * length-preserving mask — a six-letter and a three-letter name must not be
 * distinguishable from the mask alone. */
function maskName(value: string): string {
  const words = value.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return value;
  return words.map((word) => `${word[0]}***`).join(" ");
}

// ---------------------------------------------------------------------------
// Key-aware structural masking
// ---------------------------------------------------------------------------

type SensitiveKind = "name" | "phone" | "email" | "contact";

/**
 * Case-insensitive suffix match, so `leadName` and `contactPhone` are caught
 * alongside the bare `name`/`phone`/`email`/`contact` keys the data model
 * uses directly.
 */
function sensitiveKeyKind(key: string): SensitiveKind | null {
  const lower = key.toLowerCase();
  if (lower.endsWith("name")) return "name";
  if (lower.endsWith("phone")) return "phone";
  if (lower.endsWith("email")) return "email";
  if (lower.endsWith("contact")) return "contact";
  return null;
}

/**
 * A value under a sensitive key is masked whatever it contains: `contact`
 * covers a phone OR an e-mail (the data model's own definition of the slot),
 * so both are tried before falling back to the generic scrub — which still
 * never leaves the value untouched, it just cannot assume a shape for it.
 */
function maskSensitiveString(kind: SensitiveKind, value: string): string {
  switch (kind) {
    case "name":
      return maskName(value);
    case "email":
      return maskEmailValue(value) ?? maskText(value);
    case "phone":
      return maskPhoneValue(value) ?? maskText(value);
    case "contact":
      return maskEmailValue(value) ?? maskPhoneValue(value) ?? maskText(value);
  }
}

function isPlainObject(value: object): boolean {
  const proto: object | null = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A log record can nest arbitrarily deep; this is the ceiling that keeps a
 * pathological payload from ever hanging the process. Beyond it the value is
 * returned as-is rather than masked — telemetry degrading is acceptable,
 * telemetry blocking the caller is not. */
const MAX_DEPTH = 8;

function maskEntry(key: string, value: unknown, depth: number, ancestors: Set<object>): unknown {
  if (typeof value === "string") {
    const kind = sensitiveKeyKind(key);
    return kind ? maskSensitiveString(kind, value) : maskText(value);
  }
  return maskValue(value, depth + 1, ancestors);
}

function maskValue(value: unknown, depth: number, ancestors: Set<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return maskText(value);
  if (typeof value !== "object") return value; // number, boolean, bigint, symbol

  // Date, RegExp, Map, and anything else that is not a plain object or an
  // array is passed through untouched — walking it via Object.entries would
  // silently discard it (a Date has no own enumerable properties).
  if (!Array.isArray(value) && !isPlainObject(value)) return value;
  if (depth >= MAX_DEPTH) return value;
  if (ancestors.has(value)) return value; // cycle guard

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => maskValue(item, depth + 1, ancestors));
    }
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      result[key] = maskEntry(key, entryValue, depth, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Recursive, key-aware masking for arbitrary structures — a log record, a
 * span payload, an event payload. Returns a value of the same shape.
 */
export function maskPII<T>(value: T): T {
  try {
    return maskValue(value, 0, new Set<object>()) as T;
  } catch {
    return value;
  }
}
