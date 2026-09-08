import { and, asc, eq, gte, ilike, lte, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { agencies, properties } from "../db/schema.ts";
import { searchAndRank, type RankingCandidate } from "../domain/property-ranking.ts";

/**
 * The sole path to `properties` for everything above `db/` — the `/catalogo`
 * route today, spec 004's `searchProperties` tool call tomorrow. Per
 * `specs/002-data-model-seed-catalog/contracts/properties-service.md`.
 */

export interface Property {
  id: string;
  code: string;
  title: string;
  type: "apartment" | "house" | "commercial" | "land";
  transaction: "sale" | "rent";
  price: number;
  condoFee: number | null;
  areaM2: number;
  bedrooms: number;
  bathrooms: number;
  parkingSpots: number;
  neighborhood: string;
  city: string;
  region: string;
  description: string;
  features: string[];
  estimatedRent: number | null;
  imageUrl: string;
  isActive: boolean;
}

export interface PropertyFilters {
  /** Prefix match, case-insensitive — the broker's instant "is this real?" check. */
  code?: string;
  transaction?: "sale" | "rent";
  neighborhood?: string;
  region?: string;
  maxPrice?: number;
  minBedrooms?: number;
}

export interface SearchCriteria {
  transaction: "sale" | "rent";
  priceMax?: number;
  bedrooms?: number;
  neighborhoods?: string[];
}

export interface ListResult {
  items: Property[];
  total: number;
  page: number;
  pageSize: 24;
}

export const PAGE_SIZE = 24 as const;

/** Seed's demo agency slug (modelo-de-dados.md §5). */
const DEMO_AGENCY_SLUG = "demo";

/**
 * `/catalogo` renders with no session (US3 scenario 4 — spec 003 wraps
 * `(app)/*` with a session-derived `agencyId` later). Until then, this is
 * the one place the route resolves which agency's catalog to show.
 */
export async function getDefaultAgencyId(): Promise<string | undefined> {
  const db = getDb();
  const [agency] = await db
    .select({ id: agencies.id })
    .from(agencies)
    .where(eq(agencies.slug, DEMO_AGENCY_SLUG));
  return agency?.id;
}

/** Row shape returned by drizzle's `.select()` over the `properties` table. */
type PropertyRow = typeof properties.$inferSelect;

function toProperty(row: PropertyRow): Property {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    type: row.type,
    transaction: row.transaction,
    price: row.price,
    condoFee: row.condoFee,
    areaM2: row.areaM2,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    parkingSpots: row.parkingSpots,
    neighborhood: row.neighborhood,
    city: row.city,
    region: row.region,
    description: row.description,
    features: row.features,
    estimatedRent: row.estimatedRent,
    imageUrl: row.imageUrl,
    isActive: row.isActive,
  };
}

/**
 * `listProperties` — the `/catalogo` grid. Always scoped to `agencyId` and
 * `isActive = true` (FR-020, clarification 4). `page` beyond the last page
 * returns `items: []`, `total` unchanged, not an error (Edge Cases).
 */
export async function listProperties(
  agencyId: string,
  filters: PropertyFilters,
  page: number,
): Promise<ListResult> {
  const db = getDb();

  const conditions = [eq(properties.agencyId, agencyId), eq(properties.isActive, true)];
  if (filters.code) conditions.push(ilike(properties.code, `${filters.code}%`));
  if (filters.transaction) conditions.push(eq(properties.transaction, filters.transaction));
  if (filters.neighborhood) conditions.push(eq(properties.neighborhood, filters.neighborhood));
  if (filters.region) conditions.push(eq(properties.region, filters.region));
  if (filters.maxPrice !== undefined) conditions.push(lte(properties.price, filters.maxPrice));
  if (filters.minBedrooms !== undefined) conditions.push(gte(properties.bedrooms, filters.minBedrooms));

  const where = and(...conditions);
  const safePage = Math.max(1, Math.trunc(page) || 1);

  const [rows, countRows] = await Promise.all([
    db
      .select()
      .from(properties)
      .where(where)
      .orderBy(asc(properties.price), asc(properties.id))
      .limit(PAGE_SIZE)
      .offset((safePage - 1) * PAGE_SIZE),
    db.select({ count: sql<number>`count(*)::int` }).from(properties).where(where),
  ]);

  return {
    items: rows.map(toProperty),
    total: countRows[0]?.count ?? 0,
    page: safePage,
    pageSize: PAGE_SIZE,
  };
}

function toCandidate(row: PropertyRow): RankingCandidate {
  return { id: row.id, price: row.price, neighborhood: row.neighborhood, region: row.region };
}

/**
 * `searchProperties` — spec 004's suggestion tool, in practice. Fetches the
 * active/`transaction`-matching (and `bedrooms`-satisfying — never relaxed,
 * see research.md) candidate set, delegates all ranking/relaxation to the
 * pure `domain/property-ranking.ts`, then maps the winners back to full
 * `Property` rows. Never throws for "no match" — returns `[]`.
 */
export async function searchProperties(agencyId: string, criteria: SearchCriteria): Promise<Property[]> {
  const db = getDb();

  const conditions = [
    eq(properties.agencyId, agencyId),
    eq(properties.isActive, true),
    eq(properties.transaction, criteria.transaction),
  ];
  if (criteria.bedrooms !== undefined) conditions.push(gte(properties.bedrooms, criteria.bedrooms));

  const rows = await db
    .select()
    .from(properties)
    .where(and(...conditions));

  if (rows.length === 0) return [];

  const byId = new Map(rows.map((row) => [row.id, row]));
  const ranked = searchAndRank(rows.map(toCandidate), {
    priceMax: criteria.priceMax,
    neighborhoods: criteria.neighborhoods,
  });

  return ranked.map((candidate) => toProperty(byId.get(candidate.id)!));
}
