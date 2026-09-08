import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPool, closePool } from "./client.ts";
import { createLogger } from "../core/logging.ts";

/**
 * One-shot migration runner — the `migrate` Compose service's command.
 *
 * Exactly one container ever runs this, so there is no advisory-lock race to
 * get right: `app` and `worker` wait on this service via
 * `service_completed_successfully` and never attempt migration themselves.
 */

// `process.cwd()`, not `import.meta.url` — see the matching note in
// `services/health.ts`; kept consistent even though this file is run
// directly by node, unbundled.
const migrationsFolder = join(process.cwd(), "src/db/migrations");

function expectedMigrationCount(): number {
  const journal = JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8")) as {
    entries: unknown[];
  };
  return journal.entries.length;
}

async function main(): Promise<void> {
  const log = createLogger("app", { module: "migrate" });
  const db = drizzle(getPool());
  const expected = expectedMigrationCount();

  log.info({ expected }, "applying migrations");
  await migrate(db, { migrationsFolder });
  log.info({ expected }, "migrations applied");
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    const log = createLogger("app", { module: "migrate" });
    log.error({ err: error instanceof Error ? error.message : String(error) }, "migration failed");
    await closePool();
    process.exit(1);
  });
