import { and, asc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { agencies, properties } from "../db/schema.ts";

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

/**
 * Active properties that match the criteria as stated. A maximum price is a
 * maximum, a named area is that neighbourhood or region (FR-020), a bedroom count is a
 * minimum. Nothing is widened to return a fuller set. At most three, cheapest
 * first. An empty list is a normal result.
 */
export async function searchProperties(agencyId: string, criteria: SearchCriteria): Promise<Property[]> {
  const db = getDb();

  const conditions = [
    eq(properties.agencyId, agencyId),
    eq(properties.isActive, true),
    eq(properties.transaction, criteria.transaction),
  ];
  if (criteria.bedrooms !== undefined) conditions.push(gte(properties.bedrooms, criteria.bedrooms));
  if (criteria.priceMax !== undefined) conditions.push(lte(properties.price, criteria.priceMax));
  if (criteria.neighborhoods !== undefined && criteria.neighborhoods.length > 0) {
    // Spec 006 FR-020: an area the lead names is a neighbourhood **or** a region
    // — "zona norte" finds Santana. Not a widening: the lead named that area.
    const areas = criteria.neighborhoods.map((area) => area.trim().toLowerCase());
    conditions.push(
      or(inArray(properties.neighborhood, criteria.neighborhoods), inArray(sql`lower(${properties.region})`, areas))!,
    );
  }

  const rows = await db
    .select()
    .from(properties)
    .where(and(...conditions))
    .orderBy(asc(properties.price), asc(properties.id))
    .limit(3);

  return rows.map(toProperty);
}

/**
 * The rows behind a set of ids, in the order asked for — what the chat widget
 * needs to render the cards of a reply it loaded from history or was pushed over
 * SSE. `messages.metadata.propertyIds` holds ids and nothing else (the card is a
 * property of the reply, not a copy of the catalog), so the row has to be read
 * back, and it is read back **scoped by agency**: an id from another tenant
 * simply is not in the result.
 *
 * `isActive` is deliberately not required here. A property delisted after it was
 * suggested still has to render in the transcript it appears in — a bubble that
 * loses its card on a reload would be a hole in a conversation the lead
 * remembers.
 */
export async function findPropertiesByIds(agencyId: string, ids: string[]): Promise<Property[]> {
  if (ids.length === 0) return [];

  const rows = await getDb()
    .select()
    .from(properties)
    .where(and(eq(properties.agencyId, agencyId), inArray(properties.id, ids)));

  const byId = new Map(rows.map((row) => [row.id, toProperty(row)]));
  return ids.map((id) => byId.get(id)).filter((property): property is Property => property !== undefined);
}
