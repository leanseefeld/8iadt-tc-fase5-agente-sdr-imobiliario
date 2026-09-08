import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  propertyEntrySchema,
  validateDataset,
  type PropertyEntry,
} from "../src/db/seed/properties.schema.ts";

/**
 * No DB. Unit coverage for `validateDataset()` against small inline
 * fixtures (one per violation, per tasks.md T014), plus a run against the
 * real, committed `properties.json` for SC-003.
 */

const base: PropertyEntry = {
  code: "MOE-0001",
  title: "Apartamento em Moema",
  type: "apartment",
  transaction: "sale",
  price: 700_000,
  condoFee: 600,
  areaM2: 60,
  bedrooms: 2,
  bathrooms: 2,
  parkingSpots: 1,
  neighborhood: "Moema",
  city: "São Paulo",
  region: "zona sul",
  description: "Apartamento bem localizado.",
  features: ["varanda"],
  estimatedRent: 3_000,
  isActive: true,
};

function fixtureFrom(overrides: Partial<PropertyEntry>[]): PropertyEntry[] {
  return overrides.map((override, index) => ({
    ...base,
    code: `MOE-000${index + 1}`,
    ...override,
  }));
}

test("a coherent dataset has no violations", () => {
  const violations = validateDataset(fixtureFrom([{}]));
  assert.deepEqual(violations, []);
});

test("catches a duplicate code", () => {
  const violations = validateDataset(fixtureFrom([{ code: "MOE-0001" }, { code: "MOE-0001" }]));
  assert.ok(violations.some((v) => v.includes("duplicate code")));
});

test("catches a neighborhood outside modelo-de-dados.md §5", () => {
  const violations = validateDataset(fixtureFrom([{ neighborhood: "Guarulhos" }]));
  assert.ok(violations.some((v) => v.includes("not in a region named")));
});

test("catches a region that does not match the neighborhood's zone", () => {
  const violations = validateDataset(fixtureFrom([{ neighborhood: "Santana", region: "zona sul" }]));
  assert.ok(violations.some((v) => v.includes("does not match")));
});

test("catches a price outside the neighborhood's band", () => {
  const violations = validateDataset(fixtureFrom([{ neighborhood: "Santana", region: "zona norte", price: 5_000_000 }]));
  assert.ok(violations.some((v) => v.includes("outside") && v.includes("band")));
});

test("catches a sale/rent split far from ~70/30", () => {
  const entries = fixtureFrom(
    Array.from({ length: 20 }, () => ({ transaction: "rent" as const, estimatedRent: null })),
  );
  const violations = validateDataset(entries);
  assert.ok(violations.some((v) => v.includes("sale share")));
});

test("catches a commercial count far from ~15", () => {
  const entries = fixtureFrom(Array.from({ length: 100 }, () => ({ type: "commercial" as const })));
  const violations = validateDataset(entries);
  assert.ok(violations.some((v) => v.includes("commercial count")));
});

test("per-entry schema requires estimatedRent iff transaction is sale", () => {
  const bad = { ...base, transaction: "rent" as const, estimatedRent: 2_000 };
  assert.equal(propertyEntrySchema.safeParse(bad).success, false);

  const good = { ...base, transaction: "rent" as const, estimatedRent: null };
  assert.equal(propertyEntrySchema.safeParse(good).success, true);
});

// SC-003: every one of the committed 100 rows must satisfy every coherence
// rule. This runs against the real file, not a fixture.
//
// KNOWN, DOCUMENTED DEVIATION (as of this spec's implementation): this test
// currently fails. The committed src/db/seed/properties.json — generated
// separately, per spec.md's Out of Scope, and outside this spec's authority
// to edit — contains 7 rows in neighborhoods ("Itaim Bibi", "Tatuapé") not
// listed in modelo-de-dados.md §5's zones, and 23 rows priced outside the
// per-zone bands data-model.md fixes for validateDataset(). Neither
// modelo-de-dados.md nor data-model.md was changed to match the data
// (constitution I / AGENTS.md: the document wins, don't resolve silently).
// validateDataset() itself is implemented exactly per the documented rules
// and is exercised correctly by the tests above; the seed script (src/db/
// seed/index.ts) calls it and logs every violation loudly rather than
// blocking insertion, so the rest of the demo still has data. Fixing this
// requires a human decision: patch the dataset, or amend the documented
// zones/bands — not something to guess at here.
test("SC-003 — the committed properties.json is fully coherent", () => {
  const path = fileURLToPath(new URL("../src/db/seed/properties.json", import.meta.url));
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown[];

  assert.equal(raw.length, 100, `expected exactly 100 entries, found ${raw.length}`);

  const parsed: PropertyEntry[] = [];
  const schemaErrors: string[] = [];
  for (const [index, entry] of raw.entries()) {
    const result = propertyEntrySchema.safeParse(entry);
    if (result.success) {
      parsed.push(result.data);
    } else {
      schemaErrors.push(`entry ${index}: ${result.error.message}`);
    }
  }
  assert.deepEqual(schemaErrors, [], `schema violations: ${schemaErrors.join("; ")}`);

  const violations = validateDataset(parsed);
  assert.deepEqual(violations, [], `coherence violations:\n${violations.join("\n")}`);
});
