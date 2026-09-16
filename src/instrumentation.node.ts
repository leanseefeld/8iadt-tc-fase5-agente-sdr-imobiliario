import { getConfig } from "@/core/config";
import { flushLangfuse, registerLangfuse } from "@/core/langfuse";
import { createLogger } from "@/core/logging";

/**
 * The Node-only half of `src/instrumentation.ts`, in its own module so the
 * Edge bundle never contains it.
 *
 * A runtime `if (NEXT_RUNTIME !== "nodejs") return` is not enough: the bundler
 * compiles what it can see, so a static import of the OpenTelemetry packages
 * and a top-level `process.once` still land in the Edge copy and Next reports
 * "A Node.js API is used (process.once) which is not supported in the Edge
 * Runtime" followed by "Ecmascript file had an error". A dynamic `import()`
 * behind the guard is what actually keeps them apart.
 */
export async function registerNode(): Promise<void> {
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
