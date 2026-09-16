import { getConfig } from "../core/config.ts";
import { flushLangfuse, registerLangfuse } from "../core/langfuse.ts";
import { createLogger } from "../core/logging.ts";
import { closePool, getDb } from "../db/client.ts";
import { consumers } from "../jobs/consumers.ts";
import { startHealthServer } from "./health-server.ts";

/**
 * The worker: its own process, its own entrypoint, from the same image as the
 * application. It does not depend on the application being up.
 *
 * The sweep is `src/jobs/consumers.ts`, iterated with a try/catch per consumer
 * (`modelo-de-dados.md` §6): one consumer failing must not stop the others, and
 * must not stop `lastSweepAt` from moving, or a single bad row would take the
 * readiness probe down with it.
 */

const config = getConfig();
const log = createLogger("worker");

// T049. A no-op — the OpenTelemetry packages are not even imported — unless all
// three `LANGFUSE_*` keys are set, so the worker boots identically with the
// `observability` profile down.
await registerLangfuse("worker");

let lastSweepAt = Date.now();
let sweeping = false;

async function sweep(): Promise<void> {
  if (sweeping) {
    log.warn("previous sweep still running, skipping this tick");
    return;
  }
  sweeping = true;
  const now = new Date();
  try {
    for (const consumer of consumers) {
      const started = Date.now();
      try {
        await consumer.run({ db: getDb(), now, log: log.child({ consumer: consumer.name }) });
        log.debug({ consumer: consumer.name, ms: Date.now() - started }, "consumer finished");
      } catch (error) {
        log.error(
          { consumer: consumer.name, err: (error as Error).message },
          "consumer failed, continuing the sweep",
        );
      }
    }
    lastSweepAt = Date.now();
  } finally {
    sweeping = false;
  }
}

const timer = setInterval(() => {
  void sweep();
}, config.WORKER_SWEEP_INTERVAL_MS);

const healthServer = startHealthServer({
  port: config.WORKER_HEALTH_PORT,
  sweepIntervalMs: config.WORKER_SWEEP_INTERVAL_MS,
  lastSweepAt: () => lastSweepAt,
});

log.info({ sweepIntervalMs: config.WORKER_SWEEP_INTERVAL_MS }, "worker started");

void sweep();

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");

  clearInterval(timer);
  await new Promise<void>((resolve) => healthServer.close(() => resolve()));
  // Bounded inside `core/langfuse.ts`: a slow or dead Langfuse costs the
  // shutdown its timeout and nothing more (contracts/observability.md §5).
  await flushLangfuse();
  await closePool();

  log.info("shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
