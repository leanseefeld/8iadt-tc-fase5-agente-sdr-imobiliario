import { tool } from "ai";
import { z } from "zod";
import { searchProperties as searchCatalog, type Property } from "../../services/properties.ts";
import { createLogger } from "../../core/logging.ts";
import type { Intent, Slots } from "../../domain/slots.ts";

/**
 * The catalog tool — the only way a property, a code or a price reaches a lead.
 *
 * It writes no query of its own. Spec 002 already owns `searchProperties` in
 * `services/properties.ts`, which ranks, relaxes and returns `[]` rather than
 * throwing; this file is the thin layer that turns the *slot state* into that
 * service's criteria, scopes it to the agency and caps it at three (FR-024).
 * Constitution IV in one import: the agent reaches the catalog through
 * `services/`, never through `db/`.
 *
 * Two things are decided here and never by the model. The **agency** is bound by
 * the caller, so no tool argument can widen the tenant; and the search does not
 * run at all for `investment`, whose script ends with a specialist call and never
 * a listing (FR-024/FR-041).
 */

const log = createLogger("app", { module: "agent/tools/search-properties" });

/** FR-024, and `contracts/chat-api.md` §5: at most three cards per turn. */
export const MAX_SUGGESTIONS = 3;

export interface SearchContext {
  agencyId: string;
  intent: Intent;
  slots: Slots;
}

/** Empty because nothing matched — as opposed to "never asked" (FR-025, T041). */
export interface SearchOutcome {
  /** At most `MAX_SUGGESTIONS`, in ranking order. */
  properties: Property[];
  /** False when the intent or the slot state means no search was due at all. */
  searched: boolean;
  /** The one filter to offer relaxing when nothing matched (FR-025). */
  relaxable: "neighborhoods" | "priceMax" | "bedrooms" | null;
}

const EMPTY: SearchOutcome = { properties: [], searched: false, relaxable: null };

/** `purchase` buys, `rental` rents; `investment` never searches (FR-024). */
function transactionFor(intent: Intent): "sale" | "rent" | null {
  if (intent === "purchase") return "sale";
  if (intent === "rental") return "rent";
  return null;
}

/**
 * Exactly one filter, and the widest one first: a lead who named neighbourhoods
 * is best served by looking one bairro over, and only a lead who named none is
 * asked about their budget (FR-025 — *one* filter, so the agent never negotiates
 * two things at once).
 */
function relaxableFilter(slots: Slots): SearchOutcome["relaxable"] {
  if (slots.neighborhoods !== null && slots.neighborhoods.length > 0) return "neighborhoods";
  if (slots.priceMax !== null) return "priceMax";
  if (slots.bedrooms !== null) return "bedrooms";
  return null;
}

/**
 * The tool's body, callable without a tool runtime — the orchestrator invokes it
 * directly, the same way it invokes `proposeMeeting`, because "the script is
 * finished" is a decision of the slot machine and not of a 4-bit model.
 */
export async function runSearchProperties(context: SearchContext): Promise<SearchOutcome> {
  const transaction = transactionFor(context.intent);
  if (transaction === null) return EMPTY;

  const { slots } = context;
  const properties = await searchCatalog(context.agencyId, {
    transaction,
    ...(slots.priceMax === null ? {} : { priceMax: slots.priceMax }),
    ...(slots.bedrooms === null ? {} : { bedrooms: slots.bedrooms }),
    ...(slots.neighborhoods === null || slots.neighborhoods.length === 0
      ? {}
      : { neighborhoods: slots.neighborhoods }),
  });

  const capped = properties.slice(0, MAX_SUGGESTIONS);
  log.info(
    { count: capped.length, codes: capped.map((property) => property.code) },
    "catalog searched",
  );

  return {
    properties: capped,
    searched: true,
    relaxable: capped.length === 0 ? relaxableFilter(slots) : null,
  };
}

/**
 * The declared form, for the registry. Its input schema is empty on purpose: the
 * filters are the slot state the code already holds, and the agency is bound by
 * the factory — a tool argument must never be able to widen either. Offered to
 * the model only through `conversationTools(context)`, which is why it cannot
 * exist without a turn to belong to.
 */
export function searchPropertiesTool(context: SearchContext) {
  return tool({
    description:
      "Busca no catálogo da imobiliária os imóveis que combinam com o que a pessoa já contou. " +
      "Não recebe filtros: usa o que já está registrado.",
    inputSchema: z.object({}),
    execute: () => runSearchProperties(context),
  });
}
