import { getConfig } from "@/core/config";
import { flushLangfuse, registerLangfuse } from "@/core/langfuse";
import { createLogger } from "@/core/logging";

/**
 * Runs once when the Next.js server starts.
 *
 * Without this the configuration would first be parsed by whichever request
 * happened to need it, which is not what "validated at startup" means — a
 * misconfigured application would look healthy until someone used it.
 *
 * It is also where tracing is registered (T049). `registerLangfuse` is a no-op
 * — imports included — unless all three `LANGFUSE_*` keys are set, so the
 * application starts identically with the `observability` profile down, which
 * is how the demo usually runs.
 */
export async function register() {
  const config = getConfig();
  await registerLangfuse("app");

  // The exporter batches, so a container stopping mid-batch would lose the last
  // spans. The flush is bounded inside `core/langfuse.ts`: shutdown never waits
  // on Langfuse (contracts/observability.md §5).
  process.once("SIGTERM", () => void flushLangfuse());
  process.once("SIGINT", () => void flushLangfuse());

  createLogger("app").info(
    { port: config.APP_PORT, nodeEnv: config.NODE_ENV },
    "application started",
  );
}
