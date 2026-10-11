import { Client } from "pg";
import { getConfig } from "../core/config.ts";
import type { createLogger } from "../core/logging.ts";
import { FOLLOWUP_DUE_CHANNEL } from "../core/notifier.ts";

/**
 * Spec 017: the worker's doorbell. One `LISTEN` connection on
 * `FOLLOWUP_DUE_CHANNEL`; every notification calls `onWake`. A dropped
 * connection reconnects after a pause and is never fatal: without it the
 * sweep interval still sends everything, only later.
 */

const RECONNECT_DELAY_MS = 5_000;

type Logger = ReturnType<typeof createLogger>;

export interface Doorbell {
  close(): Promise<void>;
}

export function listenForWake(onWake: () => void, log: Logger): Doorbell {
  let client: Client | undefined;
  let closed = false;
  let retry: NodeJS.Timeout | undefined;

  const connect = async (): Promise<void> => {
    const next = new Client({ connectionString: getConfig().DATABASE_URL });
    next.on("notification", () => onWake());
    next.on("error", (error) => {
      log.warn({ err: error.message }, "wake connection lost");
      void next.end().catch(() => undefined);
      if (client === next) client = undefined;
      schedule();
    });
    try {
      await next.connect();
      await next.query(`LISTEN ${FOLLOWUP_DUE_CHANNEL}`);
      if (closed) {
        await next.end();
        return;
      }
      client = next;
    } catch (error) {
      log.warn({ err: (error as Error).message }, "wake connection unavailable");
      void next.end().catch(() => undefined);
      schedule();
    }
  };

  const schedule = () => {
    if (closed || retry !== undefined) return;
    retry = setTimeout(() => {
      retry = undefined;
      void connect();
    }, RECONNECT_DELAY_MS);
  };

  void connect();

  return {
    async close() {
      closed = true;
      if (retry !== undefined) clearTimeout(retry);
      await client?.end().catch(() => undefined);
    },
  };
}
