# Contract: `services/properties.ts`

The only module under `services/` this spec adds. Both functions are the sole path to `properties` for everything above `db/` — the `/catalogo` route today, spec 004's `searchProperties` tool call tomorrow.

## `listProperties(agencyId, filters, page)`

```ts
interface PropertyFilters {
  transaction?: "sale" | "rent";
  neighborhood?: string;   // exact match
  region?: string;         // exact match; neighborhood and region may combine (AND)
  maxPrice?: number;
  minBedrooms?: number;
}

function listProperties(
  agencyId: string,
  filters: PropertyFilters,
  page: number,           // 1-based
): Promise<{ items: Property[]; total: number; page: number; pageSize: 24 }>;
```

- Always scoped to `agencyId` and `isActive = true` (FR-025, clarification 4).
- `ORDER BY price ASC, id ASC` (clarification 5) — stable across pages regardless of which filters are active.
- `page` beyond the last page returns `items: []`, `total` unchanged — not an error (Edge Cases).
- `total` is the count matching `filters` before pagination, for the UI's page count.

## `searchProperties(agencyId, criteria)`

```ts
interface SearchCriteria {
  transaction: "sale" | "rent";   // derived by the caller from lead intent — not inferred here
  priceMax?: number;
  bedrooms?: number;              // minimum
  neighborhoods?: string[];       // empty or absent = "open to suggestions"
}

function searchProperties(
  agencyId: string,
  criteria: SearchCriteria,
): Promise<Property[]>;          // 0..3 items, best first
```

- Always scoped to `agencyId` and `isActive = true`.
- Ranking and the relaxation ladder are the pure function in `domain/property-ranking.ts` — see `research.md` for the exact ordering and the named `PRICE_RELAX_FACTOR` constant. This service function's only responsibility is fetching the active/`transaction`-matching candidate set and handing it to that function; it must not duplicate ranking logic inline.
- `domain/property-ranking.ts` MUST NOT import the `Property` type above (constitution III: `domain/` imports nothing). It declares its own minimal candidate shape — `{ id, price, neighborhood, region }` — the only fields ranking needs. `services/properties.ts` maps its `Property[]` down to that shape before calling in, and back up after; the domain function never sees the full entity.
- Never throws for "no match" — returns `[]` (US4 scenario 3, FR-024).
- `bedrooms` is never relaxed (see research.md's honesty note on SC-005).

## Shared type

```ts
interface Property {
  id: string; code: string; title: string;
  type: "apartment" | "house" | "commercial" | "land";
  transaction: "sale" | "rent";
  price: number; condoFee: number | null;
  areaM2: number; bedrooms: number; bathrooms: number; parkingSpots: number;
  neighborhood: string; city: string; region: string;
  description: string; features: string[];
  estimatedRent: number | null; imageUrl: string; isActive: boolean;
}
```
