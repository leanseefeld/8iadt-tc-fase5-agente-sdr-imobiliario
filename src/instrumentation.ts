import { getConfig } from "@/core/config";
import { createLogger } from "@/core/logging";

/**
 * Runs once when the Next.js server starts.
 *
 * Without this the configuration would first be parsed by whichever request
 * happened to need it, which is not what "validated at startup" means — a
 * misconfigured application would look healthy until someone used it.
 */
export function register() {
  const config = getConfig();
  createLogger("app").info(
    { port: config.APP_PORT, nodeEnv: config.NODE_ENV },
    "application started",
  );
}
