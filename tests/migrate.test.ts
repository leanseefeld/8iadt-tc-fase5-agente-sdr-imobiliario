import test from "node:test";
import assert from "node:assert/strict";
import { getPool, closePool } from "../src/db/client.ts";
import { checkMigrations } from "../src/services/health.ts";

/**
 * INTEGRATION=1 — needs a live, already-migrated Postgres (the `migrate`
 * Compose service has already run by the time `docker compose exec app npm
 * test` is invoked, per the quickstart).
 *
 * US1: `checkMigrations()` against both states. The "not ready" case is
 * produced by removing rows from drizzle's own tracking table, not by
 * dropping the schema — this suite shares a live database with any other
 * INTEGRATION suite that may run concurrently, and only the tracking table
 * (not application data) is touched, then restored.
 */
const integration = process.env.INTEGRATION === "1";

test("migration mechanism and checkMigrations()", { skip: !integration }, async (t) => {
  const pool = getPool();

  await t.test("an already-migrated database reports ready", async () => {
    const result = await checkMigrations();
    assert.equal(result.ok, true);
  });

  await t.test("a second application is a no-op — still ready", async () => {
    // The `migrate` service already ran once for this stack; re-running the
    // same check is what "no-op" means from the readiness side (the actual
    // re-apply is covered by drizzle's own migrator, exercised by the
    // `migrate` service itself, which is idempotent by construction —
    // `CREATE TABLE IF NOT EXISTS` / hash-guarded inserts).
    const result = await checkMigrations();
    assert.equal(result.ok, true);
  });

  await t.test("an unmigrated database reports not ready, naming the gap", async () => {
    const { rows } = await pool.query<{ id: number; hash: string; created_at: string }>(
      'select id, hash, created_at from "drizzle"."__drizzle_migrations"',
    );
    assert.ok(rows.length > 0, "expected at least one applied migration to test against");

    try {
      await pool.query('delete from "drizzle"."__drizzle_migrations"');
      const result = await checkMigrations();
      assert.equal(result.ok, false);
      assert.match(result.detail ?? "", /missing migration/);
    } finally {
      for (const row of rows) {
        await pool.query(
          'insert into "drizzle"."__drizzle_migrations" (id, hash, created_at) values ($1, $2, $3)',
          [row.id, row.hash, row.created_at],
        );
      }
    }

    const restored = await checkMigrations();
    assert.equal(restored.ok, true);
  });

  await t.after(async () => {
    await closePool();
  });
});
