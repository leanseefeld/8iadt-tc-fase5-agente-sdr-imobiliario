import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getConfig } from "../core/config.ts";
import { createLogger } from "../core/logging.ts";

/**
 * The data layer. Only `services/` may import this — see the lint zones in
 * eslint.config.mjs (constitution IV).
 *
 * There is no schema yet; item 2 brings the tables and migrations. What exists
 * here is the connection, so the app → services → db path is real from the
 * first commit rather than asserted.
 */

let log: ReturnType<typeof createLogger> | undefined;

/**
 * Built on first use, never at import. A logger constructed while this module
 * is merely being loaded would be constructed inside Next's build worker too,
 * which is not a place to be starting a logging transport.
 */
const logger = () => (log ??= createLogger("app", { module: "db" }));

let pool: Pool | undefined;

export function getPool(): Pool {
  pool ??= (() => {
    const created = new Pool({
      connectionString: getConfig().DATABASE_URL,
      // Shorter than the probe timeout, so a refused connection reports the
      // real reason rather than being cut off as a generic timeout.
      connectionTimeoutMillis: 1_500,
      max: 5,
    });
    // An idle client failing — which is exactly what happens when the database
    // goes away — emits on the pool. Unhandled, it would take the process down,
    // and a health surface that dies with its dependency is worthless.
    created.on("error", (error) => logger().warn({ err: error.message }, "idle pool client error"));
    return created;
  })();
  return pool;
}

export const getDb = () => drizzle(getPool());

export async function closePool(): Promise<void> {
  if (!pool) return;
  const closing = pool;
  pool = undefined;
  await closing.end();
}
