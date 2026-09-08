/**
 * Pure ranking/relaxation for `services/properties.ts`'s `searchProperties`,
 * per research.md. No I/O, no import of anything outside this file
 * (constitution III: `domain/` imports nothing) — it declares its own
 * minimal candidate shape rather than the full `Property` type, so
 * `services/` maps down to this and back up.
 */

export interface RankingCandidate {
  id: string;
  price: number;
  neighborhood: string;
  region: string;
}

export interface RankingCriteria {
  priceMax?: number;
  neighborhoods?: string[];
  bedrooms?: number; // already applied by the caller's candidate fetch — never relaxed here
}

/** Named per research.md, so a future spec can tune it without touching logic. */
export const PRICE_RELAX_FACTOR = 1.2;

const MAX_RESULTS = 3;

/**
 * modelo-de-dados.md §5's zones — the same facts `db/seed/properties.schema.ts`
 * checks the dataset against, necessarily duplicated here rather than shared:
 * `domain/` cannot import from `db/` (constitution III), and this is what lets
 * the region-relaxation step (2) work even when the exact requested
 * neighborhood has zero active candidates in the current search — the case
 * that step exists for in the first place.
 */
const ZONE_BY_NEIGHBORHOOD: Record<string, string> = {
  Moema: "zona sul",
  "Vila Mariana": "zona sul",
  Brooklin: "zona sul",
  "Campo Belo": "zona sul",
  Saúde: "zona sul",
  Pinheiros: "zona oeste",
  "Vila Madalena": "zona oeste",
  Perdizes: "zona oeste",
  Butantã: "zona oeste",
  Centro: "centro",
  Santana: "zona norte",
};

function regionsOf(neighborhoods: string[], candidates: RankingCandidate[]): Set<string> {
  const set = new Set<string>();
  for (const neighborhood of neighborhoods) {
    const region = ZONE_BY_NEIGHBORHOOD[neighborhood];
    if (region) set.add(region);
  }
  if (set.size === 0) {
    // A neighborhood outside the fixed list above (future data): fall back
    // to whatever region the candidate set itself associates with that name.
    for (const candidate of candidates) {
      if (neighborhoods.includes(candidate.neighborhood)) set.add(candidate.region);
    }
  }
  return set;
}

function rank(candidates: RankingCandidate[], priceMax: number | undefined, neighborhoods: string[]): RankingCandidate[] {
  const neighborhoodSet = new Set(neighborhoods);
  return [...candidates].sort((a, b) => {
    const priceDiffA = priceMax === undefined ? 0 : Math.abs(a.price - priceMax);
    const priceDiffB = priceMax === undefined ? 0 : Math.abs(b.price - priceMax);
    if (priceDiffA !== priceDiffB) return priceDiffA - priceDiffB;

    const matchA = neighborhoodSet.has(a.neighborhood) ? 0 : 1;
    const matchB = neighborhoodSet.has(b.neighborhood) ? 0 : 1;
    if (matchA !== matchB) return matchA - matchB;

    return a.id.localeCompare(b.id);
  });
}

/**
 * Relaxation ladder (research.md): neighborhood -> region -> drop location
 * -> widen price (`PRICE_RELAX_FACTOR`), stopping at the first non-empty
 * step. `bedrooms` is never relaxed — the caller's candidate set is already
 * filtered to it. Never throws for "no match": returns `[]`.
 */
export function searchAndRank(
  candidates: RankingCandidate[],
  criteria: RankingCriteria,
): RankingCandidate[] {
  const neighborhoods = criteria.neighborhoods ?? [];

  // Step 1: exact neighborhoods (skipped if the list is empty — "open to suggestions").
  if (neighborhoods.length > 0) {
    const matches = candidates.filter((c) => neighborhoods.includes(c.neighborhood));
    if (matches.length > 0) {
      return rank(matches, criteria.priceMax, neighborhoods).slice(0, MAX_RESULTS);
    }
  }

  // Step 2: same region as the requested neighborhoods.
  if (neighborhoods.length > 0) {
    const regions = regionsOf(neighborhoods, candidates);
    if (regions.size > 0) {
      const matches = candidates.filter((c) => regions.has(c.region));
      if (matches.length > 0) {
        return rank(matches, criteria.priceMax, neighborhoods).slice(0, MAX_RESULTS);
      }
    }
  }

  // Step 3: no location filter at all.
  if (candidates.length > 0 && criteria.priceMax === undefined) {
    return rank(candidates, criteria.priceMax, neighborhoods).slice(0, MAX_RESULTS);
  }
  if (candidates.length > 0) {
    const withinPrice = candidates.filter((c) => c.price <= criteria.priceMax!);
    if (withinPrice.length > 0) {
      return rank(withinPrice, criteria.priceMax, neighborhoods).slice(0, MAX_RESULTS);
    }

    // Step 4: no location filter, widened price ceiling.
    const widenedMax = criteria.priceMax! * PRICE_RELAX_FACTOR;
    const widened = candidates.filter((c) => c.price <= widenedMax);
    if (widened.length > 0) {
      return rank(widened, criteria.priceMax, neighborhoods).slice(0, MAX_RESULTS);
    }
  }

  return [];
}
