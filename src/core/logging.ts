import pino, { type Logger } from "pino";
import { getConfig } from "./config.ts";

/**
 * The only module in the repository that imports the logging library.
 *
 * That single import point is what lets item 4 add request-scoped context
 * without touching a call site. Nothing else may import pino directly.
 */

export type ProcessName = "app" | "worker";

let root: Logger | undefined;

function rootLogger(): Logger {
  root ??= pino({
    level: getConfig().LOG_LEVEL,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      bindings: () => ({}),
    },
  });
  return root;
}

export function createLogger(name: ProcessName, bindings: Record<string, unknown> = {}): Logger {
  return rootLogger().child({ process: name, ...bindings });
}
