import pino, { type Logger } from "pino";
import { getConfig } from "./config.ts";
import { maskPII, maskText } from "./security.ts";

/**
 * The only module in the repository that imports the logging library.
 *
 * That single import point is what lets item 4 add request-scoped context
 * without touching a call site. Nothing else may import pino directly.
 *
 * It is also where FR-031's masking rule reaches the log sink. `maskPII` has one
 * definition in `core/security.ts` and two sinks — this logger and the Langfuse
 * span mask — so a lead's telephone cannot be masked in a trace and printed in a
 * log because someone patched one of them.
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
      // Everything merged into a record — objects, arrays, nested payloads.
      log: (record) => maskPII(record),
    },
    hooks: {
      // `formatters.log` never sees the message string, and interpolating a
      // lead's e-mail straight into one is exactly how PII reaches a log line.
      logMethod(args, method) {
        const masked = args.map((argument) =>
          typeof argument === "string" ? maskText(argument) : argument,
        ) as typeof args;
        method.apply(this, masked);
      },
    },
  });
  return root;
}

export function createLogger(name: ProcessName, bindings: Record<string, unknown> = {}): Logger {
  return rootLogger().child({ process: name, ...bindings });
}
