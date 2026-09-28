import { tool } from "ai";
import { z } from "zod";
import { searchProperties as searchCatalog, type Property } from "../../services/properties.ts";
import { createLogger } from "../../core/logging.ts";
import type { Intent, Slots } from "../../domain/slots.ts";

/**
 * The catalog tool — the only way a property, a code or a price reaches a lead.
 *
 * It writes no query of its own. `searchProperties` in `services/properties.ts`
 * applies the stated filters and returns `[]` when nothing matches; this file
 * turns the slot state into those criteria and scopes the search to the agency.
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
  /** The turn collects each successful search. Not a model argument. */
  onOutcome?: (outcome: SearchOutcome) => void;
}

/** What a refused action returns. The model can read it and choose another step. */
export interface ToolRefusal {
  ok: false;
  reason: string;
  message: string;
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
 * The tool's body. The loop calls it; the agency and the investment refusal
 * are already bound in `context`, so a model argument cannot widen either.
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

const REFUSAL = {
  notSearchable: {
    ok: false as const,
    reason: "notSearchable",
    message: "Esta conversa não busca imóvel no catálogo. Não chame a busca de novo.",
  },
  failed: {
    ok: false as const,
    reason: "failed",
    message: "A busca falhou. Siga com o que você já tem, sem inventar imóvel.",
  },
};

/**
 * The one action the model may call. Agency and the refusal to search for an
 * investment lead come from the turn, never from the arguments (FR-014).
 */
export function searchPropertiesTool(context: SearchContext) {
  return tool({
    description:
      "Busca imóveis no catálogo com os critérios que a pessoa já informou. " +
      "Quando chamar: um critério de busca mudou ou o roteiro de busca acabou de ficar completo. " +
      "Quando NÃO chamar: a mensagem é só cumprimento, reação ou agradecimento; a pessoa está " +
      "investindo; ou você já recebeu imóveis e nenhum critério mudou. " +
      "Não recebe filtros. Se ok for false, leia o motivo e não invente imóvel.",
    inputSchema: z.object({}),
    execute: async () => {
      // Preconditions that do not hold are a result, not an exception (FR-013b).
      if (transactionFor(context.intent) === null) return REFUSAL.notSearchable;
      try {
        const outcome = await runSearchProperties(context);
        context.onOutcome?.(outcome);
        return {
          ok: true as const,
          count: outcome.properties.length,
          codes: outcome.properties.map((property) => property.code),
          relaxable: outcome.relaxable,
        };
      } catch (error) {
        log.warn({ err: (error as Error).message }, "search tool failed");
        return REFUSAL.failed;
      }
    },
  });
}
