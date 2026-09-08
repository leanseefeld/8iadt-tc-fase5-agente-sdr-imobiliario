import { z } from "zod";

/**
 * Contract for one entry of `src/db/seed/properties.json`, per
 * `specs/002-data-model-seed-catalog/data-model.md`'s "Seed data shape".
 *
 * `imageUrl` is deliberately not part of this schema — FR-012 computes it
 * deterministically from `code` at seed time (`z.object` strips unknown keys
 * on parse, so a stray `imageUrl` already in the file is simply ignored).
 */
export const propertyEntrySchema = z
  .object({
    code: z
      .string()
      .regex(/^[A-Z]{2,4}-\d{4}$/, "expected a code like MOE-0042"),
    title: z.string().min(1),
    type: z.enum(["apartment", "house", "commercial", "land"]),
    transaction: z.enum(["sale", "rent"]),
    price: z.number().int().positive(),
    condoFee: z.number().int().nonnegative().nullable(),
    areaM2: z.number().int().positive(),
    bedrooms: z.number().int().nonnegative(),
    bathrooms: z.number().int().nonnegative(),
    parkingSpots: z.number().int().nonnegative(),
    neighborhood: z.string().min(1),
    city: z.string().min(1),
    region: z.string().min(1),
    description: z.string().min(1),
    features: z.array(z.string()),
    estimatedRent: z.number().int().positive().nullable(),
    // The documented shape shows `true` as the typical case, but the
    // committed dataset deliberately includes a few `false` rows so the
    // catalog/search `isActive` filter (FR-014/FR-019) has something real
    // to prove against — accepting both is what lets that data exist.
    isActive: z.boolean(),
  })
  .refine((entry) => (entry.transaction === "sale" ? entry.estimatedRent !== null : entry.estimatedRent === null), {
    message: "estimatedRent must be set iff transaction is 'sale'",
  });

export type PropertyEntry = z.infer<typeof propertyEntrySchema>;

/**
 * modelo-de-dados.md §5's zones, and the price bands
 * `specs/002-data-model-seed-catalog/data-model.md` fixes for
 * `validateDataset()`. This is the single source both the dataset test and
 * the seed's coherence pass check against.
 */
export const ZONES: Record<string, { region: string; sale: [number, number]; rent: [number, number] }> = {
  Moema: { region: "zona sul", sale: [600_000, 3_500_000], rent: [3_000, 15_000] },
  "Vila Mariana": { region: "zona sul", sale: [600_000, 3_500_000], rent: [3_000, 15_000] },
  Brooklin: { region: "zona sul", sale: [600_000, 3_500_000], rent: [3_000, 15_000] },
  "Campo Belo": { region: "zona sul", sale: [600_000, 3_500_000], rent: [3_000, 15_000] },
  Saúde: { region: "zona sul", sale: [600_000, 3_500_000], rent: [3_000, 15_000] },
  Pinheiros: { region: "zona oeste", sale: [550_000, 3_200_000], rent: [2_800, 14_000] },
  "Vila Madalena": { region: "zona oeste", sale: [550_000, 3_200_000], rent: [2_800, 14_000] },
  Perdizes: { region: "zona oeste", sale: [550_000, 3_200_000], rent: [2_800, 14_000] },
  Butantã: { region: "zona oeste", sale: [550_000, 3_200_000], rent: [2_800, 14_000] },
  Centro: { region: "centro", sale: [250_000, 900_000], rent: [1_500, 5_000] },
  Santana: { region: "zona norte", sale: [280_000, 950_000], rent: [1_600, 5_500] },
};

/** Tolerance around the "~70/30" and "~15 commercial" targets (FR-011). */
const SALE_SHARE_TARGET = 0.7;
const SALE_SHARE_TOLERANCE = 0.15;
const COMMERCIAL_TARGET = 15;
const COMMERCIAL_TOLERANCE = 6;

/**
 * Aggregate coherence rules over the whole dataset — region matches the
 * neighborhood's documented zone, price within that zone's band for the
 * row's transaction, the sale/rent split and commercial share are close to
 * their documented targets. Returns every violation found (empty = valid);
 * it never throws, so callers choose how loudly to fail.
 */
export function validateDataset(entries: PropertyEntry[]): string[] {
  const violations: string[] = [];

  const codes = new Set<string>();
  let saleCount = 0;
  let commercialCount = 0;

  for (const entry of entries) {
    if (codes.has(entry.code)) violations.push(`duplicate code: ${entry.code}`);
    codes.add(entry.code);

    if (entry.transaction === "sale") saleCount += 1;
    if (entry.type === "commercial") commercialCount += 1;

    const zone = ZONES[entry.neighborhood];
    if (!zone) {
      violations.push(
        `${entry.code}: neighborhood "${entry.neighborhood}" is not in a region named in modelo-de-dados.md §5`,
      );
      continue;
    }
    if (entry.region !== zone.region) {
      violations.push(
        `${entry.code}: region "${entry.region}" does not match "${entry.neighborhood}"'s documented zone "${zone.region}"`,
      );
    }
    const [lo, hi] = zone[entry.transaction];
    if (entry.price < lo || entry.price > hi) {
      violations.push(
        `${entry.code}: price ${entry.price} outside ${entry.neighborhood}'s ${entry.transaction} band [${lo}, ${hi}]`,
      );
    }
  }

  // Below this size, the ~70/30 and ~15-commercial targets are meaningless
  // noise (a 1-entry fixture is trivially "100% sale") — only worth checking
  // at something close to the real dataset's scale.
  const MIN_SAMPLE_FOR_SHARE_CHECKS = 20;
  if (entries.length >= MIN_SAMPLE_FOR_SHARE_CHECKS) {
    const saleShare = saleCount / entries.length;
    if (Math.abs(saleShare - SALE_SHARE_TARGET) > SALE_SHARE_TOLERANCE) {
      violations.push(
        `sale share ${(saleShare * 100).toFixed(0)}% is far from the ~70% target (${saleCount}/${entries.length})`,
      );
    }
    if (Math.abs(commercialCount - COMMERCIAL_TARGET) > COMMERCIAL_TOLERANCE) {
      violations.push(
        `commercial count ${commercialCount} is far from the ~15 target`,
      );
    }
  }

  return violations;
}
