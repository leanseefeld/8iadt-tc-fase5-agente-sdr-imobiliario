import type { Logger } from "pino";
import type { getDb } from "../db/client.ts";
import { summarize } from "./summarize.ts";
import { unansweredTurns } from "./unanswered-turns.ts";

/**
 * The worker's consumer registry — `modelo-de-dados.md` §6, signature for
 * signature.
 *
 * §6 assigns this file to spec 005, but 004 needs `unanswered-turns` before 005
 * lands, so 004 creates it and 005 adds to the array. That swap is recorded in
 * `specs/004-conversation/plan.md`'s boundary notes rather than made silently.
 *
 * The array is the extension point: `src/worker/index.ts` iterates it with a
 * try/catch per consumer, so a consumer that throws costs its own sweep and
 * nobody else's.
 */

export type Database = ReturnType<typeof getDb>;

export interface SweepContext {
  db: Database;
  now: Date;
  log: Logger;
}

export interface SweepConsumer {
  name: string;
  run(ctx: SweepContext): Promise<void>;
}

/** Runs in order, once per sweep. Spec 005 and 006 append; nothing reorders. */
export const consumers: SweepConsumer[] = [unansweredTurns, summarize];
