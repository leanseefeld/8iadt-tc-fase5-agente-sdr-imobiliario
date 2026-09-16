import { closePool, getPool } from "./client.ts";
import { createLogger } from "../core/logging.ts";

/**
 * Empties every table and leaves the schema alone, so `db:seed` can put the demo
 * back exactly as it was.
 *
 * The recipe this replaces was `docker compose down -v`, and it had a trap with
 * teeth: `-v` removes the `node_modules` volume as well as the data one, and
 * this project's dependencies live in that volume rather than in the image —
 * they were installed with `docker compose exec app npm install`. After a
 * `down -v` the worker exits on `ERR_MODULE_NOT_FOUND: Cannot find package 'ai'`
 * while the app still reports **healthy**, because `/api/health/ready` touches
 * the database and the migrations and never the orchestrator. The first chat
 * turn is where anyone would find out.
 *
 * Nothing here touches Docker, so nothing here can do that.
 *
 * `TRUNCATE ... CASCADE` in one statement rather than nine `DELETE`s: the
 * foreign keys between leads, conversations, messages and events make ordering a
 * puzzle, and a single truncate has no order to get wrong.
 */

const log = createLogger("app", { module: "db/reset" });

/** Every table the application owns. `drizzle` keeps its migration ledger in its own schema. */
const TABLES = [
  "events",
  "messages",
  "appointments",
  "followup_jobs",
  "conversations",
  "leads",
  "properties",
  "users",
  "agencies",
] as const;

async function main(): Promise<void> {
  await getPool().query(`truncate table ${TABLES.join(", ")} restart identity cascade`);
  log.info({ tables: TABLES.length }, "database emptied — run db:seed to put the demo back");
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    log.error({ err: error instanceof Error ? error.message : String(error) }, "reset failed");
    await closePool();
    process.exit(1);
  });
