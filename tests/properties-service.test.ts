import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getPool, closePool } from "../src/db/client.ts";
import { getDefaultAgencyId, listProperties, searchProperties } from "../src/services/properties.ts";

/**
 * INTEGRATION=1 — needs a live, migrated, seeded Postgres. US3/US4:
 * `listProperties` (filtered, zero-result, paging-stability) and
 * `searchProperties` (exact, relaxed, empty-agency, cross-agency isolation)
 * against the real seeded catalog.
 */
const integration = process.env.INTEGRATION === "1";
const run = promisify(execFile);

test("properties service against the seeded catalog", { skip: !integration }, async (t) => {
  await run("node", ["src/db/seed/index.ts"], { cwd: process.cwd() });
  const agencyId = await getDefaultAgencyId();
  assert.ok(agencyId, "expected the seeded demo agency to exist");

  await t.test("listProperties: unfiltered returns 24, sorted price then id", async () => {
    const result = await listProperties(agencyId!, {}, 1);
    assert.equal(result.items.length, 24);
    assert.equal(result.pageSize, 24);
    assert.ok(result.total >= 97); // 100 seeded, a few inactive
    for (let i = 1; i < result.items.length; i++) {
      const prev = result.items[i - 1];
      const curr = result.items[i];
      assert.ok(prev.price < curr.price || (prev.price === curr.price && prev.id < curr.id));
    }
    for (const item of result.items) assert.equal(item.isActive, true);
  });

  await t.test("listProperties: code prefix filter narrows and is case-insensitive", async () => {
    const result = await listProperties(agencyId!, { code: "moe" }, 1);
    assert.ok(result.items.length > 0);
    for (const item of result.items) assert.match(item.code, /^MOE-/);
  });

  await t.test("listProperties: an impossible filter returns an empty grid, not an error", async () => {
    const result = await listProperties(agencyId!, { maxPrice: 1 }, 1);
    assert.deepEqual(result.items, []);
    assert.equal(result.total, 0);
  });

  await t.test("listProperties: paging is stable — page 2 never repeats page 1", async () => {
    const page1 = await listProperties(agencyId!, {}, 1);
    const page2 = await listProperties(agencyId!, {}, 2);
    const ids1 = new Set(page1.items.map((i) => i.id));
    for (const item of page2.items) assert.ok(!ids1.has(item.id));
    assert.equal(page1.total, page2.total);
  });

  await t.test("listProperties: past the last page returns an empty grid", async () => {
    const result = await listProperties(agencyId!, {}, 999);
    assert.deepEqual(result.items, []);
  });

  await t.test("searchProperties: exact match, ranked, at most 3", async () => {
    const result = await searchProperties(agencyId!, {
      transaction: "sale",
      priceMax: 700_000,
      bedrooms: 2,
      neighborhoods: ["Moema"],
    });
    assert.ok(result.length > 0 && result.length <= 3);
    for (const property of result) {
      assert.equal(property.transaction, "sale");
      assert.ok(property.bedrooms >= 2);
      assert.equal(property.isActive, true);
    }
  });

  await t.test("searchProperties: relaxes when nothing matches the exact neighborhood", async () => {
    const result = await searchProperties(agencyId!, {
      transaction: "sale",
      priceMax: 700_000,
      neighborhoods: ["Neighborhood That Does Not Exist"],
    });
    // Relaxes past neighborhood/region straight to "no location filter" —
    // still finds candidates within/near the price ceiling.
    assert.ok(result.length > 0);
  });

  await t.test("searchProperties: never throws for no match, returns []", async () => {
    const result = await searchProperties(agencyId!, {
      transaction: "sale",
      bedrooms: 999,
    });
    assert.deepEqual(result, []);
  });

  await t.test("searchProperties: cross-agency isolation — a foreign agency sees nothing", async () => {
    const result = await searchProperties("00000000-0000-0000-0000-000000000000", {
      transaction: "sale",
    });
    assert.deepEqual(result, []);
  });

  await t.after(async () => {
    await closePool();
  });
});
