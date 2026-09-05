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
