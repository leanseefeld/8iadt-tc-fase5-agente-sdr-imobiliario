import { createServer, type Server } from "node:http";
import { liveness, readiness, type CheckResult } from "../core/health.ts";
import { checkDatabase } from "../services/health.ts";
import { createLogger } from "../core/logging.ts";

/**
 * The worker answers for itself. It is not otherwise an HTTP server; this
 * listener exists so a container orchestrator can ask, and so a hung sweep is
 * visible.
 */

/**
 * Three intervals rather than one: absorbs a slow sweep without flapping.
 * Derived from the configured interval rather than being its own key — a
 * second knob would only create a way to set the two inconsistently.
 */
const STALE_SWEEP_MULTIPLIER = 3;

export interface HealthServerOptions {
  port: number;
  sweepIntervalMs: number;
  lastSweepAt: () => number;
}

function checkSweep(options: HealthServerOptions): CheckResult {
  const ageMs = Date.now() - options.lastSweepAt();
  const limitMs = options.sweepIntervalMs * STALE_SWEEP_MULTIPLIER;
  const ok = ageMs <= limitMs;
  const ageSeconds = Math.round(ageMs / 1000);

  return {
    name: "sweep",
    ok,
    latencyMs: 0,
    detail: ok
      ? `last sweep ${ageSeconds}s ago`
      : `no sweep for ${ageSeconds}s, limit ${Math.round(limitMs / 1000)}s`,
  };
}

export function startHealthServer(options: HealthServerOptions): Server {
  const log = createLogger("worker", { module: "health" });

  const server = createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0];

    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };

    if (path === "/health") {
      send(200, liveness("worker"));
      return;
    }

    if (path === "/health/ready") {
      void (async () => {
        const report = readiness("worker", [await checkDatabase(), checkSweep(options)]);
        send(report.status === "ready" ? 200 : 503, report);
      })();
      return;
    }

    send(404, { error: "not_found" });
  });

  server.listen(options.port, "0.0.0.0", () => {
    log.info({ port: options.port }, "health server listening");
  });

  return server;
}
