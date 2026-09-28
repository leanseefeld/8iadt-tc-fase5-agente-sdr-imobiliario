import test from "node:test";
import assert from "node:assert/strict";
import { nextBrokerInRotation } from "../src/domain/scheduling.ts";

/** SC-004 and FR-003: even, repeatable rotation — never random. */

test("the fewest assignments wins, ties go to list order", () => {
  assert.equal(nextBrokerInRotation(["a", "b", "c"], { a: 2, b: 1, c: 1 }), "b");
  assert.equal(nextBrokerInRotation(["a", "b", "c"], {}), "a");
  assert.equal(nextBrokerInRotation(["c", "b", "a"], {}), "c", "order is the caller's, not alphabetical");
});

test("SC-004: 30 assignments among specialists differ by at most one", () => {
  const roster = [
    { id: "ana", specializations: ["purchase", "rental"] },
    { id: "bruno", specializations: ["purchase"] },
    { id: "carla", specializations: ["investment"] },
    { id: "davi", specializations: ["purchase", "investment"] },
  ];
  const counts: Record<string, number> = {};
  const specialists = roster.filter((b) => b.specializations.includes("purchase")).map((b) => b.id);
  for (let i = 0; i < 30; i += 1) {
    const chosen = nextBrokerInRotation(specialists, counts);
    counts[chosen] = (counts[chosen] ?? 0) + 1;
  }
  const values = specialists.map((id) => counts[id] ?? 0);
  assert.equal(values.reduce((a, b) => a + b, 0), 30);
  assert.ok(Math.max(...values) - Math.min(...values) <= 1, JSON.stringify(counts));
  assert.equal(counts.carla, undefined, "a non-specialist is never picked while specialists exist");
});

test("with no specialist, the caller's fallback to the whole roster still rotates evenly", () => {
  const everyone = ["ana", "bruno", "carla"];
  const counts: Record<string, number> = {};
  for (let i = 0; i < 9; i += 1) {
    const chosen = nextBrokerInRotation(everyone, counts);
    counts[chosen] = (counts[chosen] ?? 0) + 1;
  }
  assert.deepEqual(counts, { ana: 3, bruno: 3, carla: 3 });
});

test("an empty roster is the caller's edge to check first, so it throws", () => {
  assert.throws(() => nextBrokerInRotation([], {}));
});
