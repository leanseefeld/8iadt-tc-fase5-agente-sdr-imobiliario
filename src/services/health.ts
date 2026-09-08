import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { probe, type CheckResult } from "../core/health.ts";
import { getPool } from "../db/client.ts";

/** The only module that touches `db/`. Route handlers come through here. */
export function checkDatabase(): Promise<CheckResult> {
  return probe("database", async () => {
    const client = await getPool().connect();
    try {
      await client.query("select 1");
    } finally {
      client.release();
    }
  });
}

interface JournalEntry {
  tag: string;
  when: number;
}

interface Journal {
  entries: JournalEntry[];
}

// `process.cwd()`, not `new URL(dir, import.meta.url)`: the latter is a
// directory reference, and bundlers (Turbopack included) statically parse
// `new URL(x, import.meta.url)` as a module/asset import, which fails on a
// directory. Both processes run from `/app` (Dockerfile WORKDIR), in
// development (bind mount) and production alike, so this is safe.
const migrationsDir = join(process.cwd(), "src/db/migrations");

/**
 * Same hash drizzle-orm's migrator computes and stores per applied migration
 * (`node_modules/drizzle-orm/migrator.cjs`): sha256 of the raw `.sql` file
 * content. Recomputing it here, rather than trusting a hand-maintained count,
 * is what lets this check catch a half-applied schema (research.md).
 */
function expectedHashes(): Map<string, string> {
  const journal = JSON.parse(
    readFileSync(`${migrationsDir}/meta/_journal.json`, "utf8"),
  ) as Journal;
  const hashes = new Map<string, string>();
  for (const entry of journal.entries) {
    const sql = readFileSync(`${migrationsDir}/${entry.tag}.sql`, "utf8");
    hashes.set(entry.tag, createHash("sha256").update(sql).digest("hex"));
  }
  return hashes;
}

/**
 * Compares the journal committed in the image against drizzle's own
 * migrations-tracking table (`drizzle.__drizzle_migrations`). Reports the
 * first missing migration by name, per FR-006 — "neither process starts on a
 * half schema" only holds if the failure names the gap, not just says "no".
 */
export function checkMigrations(): Promise<CheckResult> {
  return probe("migrations", async () => {
    const expected = expectedHashes();
    if (expected.size === 0) {
      throw new Error("no migrations found in src/db/migrations/meta/_journal.json");
    }

    const client = await getPool().connect();
    let applied: Set<string>;
    try {
      const result = await client.query<{ hash: string }>(
        `select hash from "drizzle"."__drizzle_migrations"`,
      );
      applied = new Set(result.rows.map((row) => row.hash));
    } catch (error) {
      // The tracking table/schema does not exist yet — an entirely
      // unmigrated database, not an unexpected failure.
      const message = error instanceof Error ? error.message : String(error);
      if (!/does not exist/i.test(message)) throw error;
      applied = new Set();
    } finally {
      client.release();
    }

    const missing = [...expected.entries()]
      .filter(([, hash]) => !applied.has(hash))
      .map(([tag]) => tag);

    if (missing.length > 0) {
      throw new Error(`missing migration(s): ${missing.join(", ")}`);
    }
  });
}
