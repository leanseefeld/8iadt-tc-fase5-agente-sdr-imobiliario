import test from "node:test";
import assert from "node:assert/strict";
import { searchAndRank, PRICE_RELAX_FACTOR, type RankingCandidate } from "../src/domain/property-ranking.ts";

/** No DB — pure function. US4. */

function candidate(id: string, price: number, neighborhood: string, region: string): RankingCandidate {
  return { id, price, neighborhood, region };
}

test("exact neighborhood match, ranked by price proximity", () => {
  const candidates = [
    candidate("a", 500_000, "Moema", "zona sul"),
    candidate("b", 650_000, "Moema", "zona sul"),
    candidate("c", 800_000, "Moema", "zona sul"),
    candidate("d", 400_000, "Santana", "zona norte"),
  ];
  const result = searchAndRank(candidates, { priceMax: 650_000, neighborhoods: ["Moema"] });
  assert.deepEqual(result.map((r) => r.id), ["b", "a", "c"]);
});

test("relaxes to region when no exact neighborhood match", () => {
  const candidates = [
    candidate("a", 600_000, "Vila Mariana", "zona sul"),
    candidate("b", 400_000, "Santana", "zona norte"),
  ];
  const result = searchAndRank(candidates, { priceMax: 600_000, neighborhoods: ["Moema"] });
  assert.deepEqual(result.map((r) => r.id), ["a"]);
});

test("drops location filter when the region has nothing either", () => {
  const candidates = [candidate("a", 600_000, "Santana", "zona norte")];
  const result = searchAndRank(candidates, { priceMax: 600_000, neighborhoods: ["Moema"] });
  assert.deepEqual(result.map((r) => r.id), ["a"]);
});

test("widens the price band as the last resort", () => {
  const candidates = [candidate("a", 700_000, "Santana", "zona norte")];
  const result = searchAndRank(candidates, { priceMax: 600_000, neighborhoods: [] });
  assert.deepEqual(result.map((r) => r.id), ["a"]);
  assert.ok(700_000 <= 600_000 * PRICE_RELAX_FACTOR);
});

test("empty neighborhoods list skips the neighborhood/region steps", () => {
  const candidates = [candidate("a", 600_000, "Santana", "zona norte")];
  const result = searchAndRank(candidates, { priceMax: 650_000, neighborhoods: [] });
  assert.deepEqual(result.map((r) => r.id), ["a"]);
});

test("empty candidate list returns empty, never throws", () => {
  assert.deepEqual(searchAndRank([], { priceMax: 500_000, neighborhoods: ["Moema"] }), []);
});

test("price ties within the same step break by id", () => {
  const candidates = [
    candidate("z", 500_000, "Moema", "zona sul"),
    candidate("a", 500_000, "Moema", "zona sul"),
  ];
  const result = searchAndRank(candidates, { priceMax: 500_000, neighborhoods: ["Moema"] });
  assert.deepEqual(result.map((r) => r.id), ["a", "z"]);
});

test("region relaxation works even with zero exact-neighborhood candidates", () => {
  // Nothing in the candidate set is literally "Moema" — the region step
  // must still know Moema is zona sul (research.md's regionsOf), which is
  // exactly what the fixed zone table exists for.
  const candidates = [
    candidate("brk", 500_000, "Brooklin", "zona sul"),
    candidate("san", 500_000, "Santana", "zona norte"),
  ];
  const result = searchAndRank(candidates, { priceMax: 500_000, neighborhoods: ["Moema"] });
  assert.deepEqual(result.map((r) => r.id), ["brk"]);
});

test("returns at most 3, best first", () => {
  const candidates = Array.from({ length: 10 }, (_, i) => candidate(`p${i}`, 500_000 + i * 1_000, "Moema", "zona sul"));
  const result = searchAndRank(candidates, { priceMax: 500_000, neighborhoods: ["Moema"] });
  assert.equal(result.length, 3);
  assert.deepEqual(result.map((r) => r.id), ["p0", "p1", "p2"]);
});
