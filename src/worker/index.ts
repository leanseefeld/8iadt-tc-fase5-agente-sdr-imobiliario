import { getConfig } from "../core/config.ts";
import { createLogger } from "../core/logging.ts";
import { closePool } from "../db/client.ts";
import { startHealthServer } from "./health-server.ts";

/**
 * The worker: its own process, its own entrypoint, from the same image as the
 * application. It does not depend on the application being up.
 *
 * There is nothing to sweep yet — `followup_jobs` arrives with the data model.
 * The loop turns anyway, so that the shape of the process, its shutdown and its
 * health signal are all real before there is work to put through them.
 */

const config = getConfig();
const log = createLogger("worker");

let lastSweepAt = Date.now();
let sweeping = false;

async function sweep(): Promise<void> {
  if (sweeping) {
    log.warn("previous sweep still running, skipping this tick");
    return;
  }
  sweeping = true;
  try {
    // No queue tables exist yet. Item 11 fills this in.
    log.debug("sweep complete, nothing to do");
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
  await closePool();

  log.info("shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
