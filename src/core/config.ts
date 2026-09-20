import { z } from "zod";

/**
 * The single configuration contract, mirrored by `.env.example` and
 * `specs/001-walking-skeleton/contracts/config.md`. Adding a key means touching
 * all three in one commit — `tests/env-example.test.ts` enforces two of them.
 *
 * Both processes load this. The worker calls the model too, so provider settings
 * are not application-only.
 */

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");
const flag = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

/**
 * `CHAT_TYPING_DELAY_MS` is a range, not a number — a fixed pause reads as a
 * machine. Written `min-max`; `0-0` disables the pause, which is what the
 * scenario tests set. Parsed here so `channels/web.ts` receives two numbers
 * and no string handling of its own.
 */
const millisecondRange = z
  .string()
  .regex(/^\d+\s*[-\u2013]\s*\d+$/, "expected a range like 300-800")
  .default("300-800")
  .transform((value) => {
    const [minMs, maxMs] = value.split(/\s*[-\u2013]\s*/).map(Number);
    return { minMs, maxMs };
  })
  .refine(({ minMs, maxMs }) => minMs <= maxMs, "the low end must not exceed the high end");

export const configSchema = z.object({
  // Model provider
  PROVIDER_BASE_URL: z.url(),
  PROVIDER_API_KEY: z.string().min(1),
  MODEL_ID: z.string().min(1),
  MODEL_TIMEOUT_MS: positiveInt.default(30_000),
  MODEL_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  // Header name carrying the key when the endpoint refuses
  // `Authorization: Bearer`. Absent means Bearer — the third and last provider
  // variable ADR 16 permits.
  PROVIDER_AUTH_HEADER: z.string().min(1).optional(),
  MODEL_THINKING: flag,
  // Defaulted after parsing, because the default depends on MODEL_THINKING:
  // reasoning tokens count against this ceiling, and 600 leaves nothing for
  // the answer once the model thinks first.
  MODEL_MAX_OUTPUT_TOKENS: positiveInt.optional(),
  MODEL_HISTORY_WINDOW: positiveInt.default(12),

  // Conversation
  CHAT_DEBOUNCE_MS: positiveInt.default(3_000),
  CHAT_MESSAGE_BUDGET: positiveInt.default(60),
  CHAT_BUDGET_WINDOW_MINUTES: positiveInt.default(30),
  CHAT_MAX_MESSAGE_CHARS: positiveInt.default(1_000),
  CHAT_TYPING_DELAY_MS: millisecondRange,
  SSE_PULSE_INTERVAL_MS: positiveInt.default(15_000),

  // Database
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (value) => /^postgres(ql)?:\/\//.test(value),
      "expected a postgres:// or postgresql:// URL",
    ),

  // Runtime
  APP_PORT: port.default(3100),
  WORKER_HEALTH_PORT: port.default(3101),
  // Read by docker-compose.yml to publish Postgres on the host, not by
  // application code — nothing inside the network uses it. Declared here
  // because the schema is the authoritative key set.
  DB_PORT: port.default(55432),
  WORKER_SWEEP_INTERVAL_MS: positiveInt.default(900_000),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  WATCHPACK_POLLING: flag,

  // Signs the session cookie (spec 003). Required: without it nothing can
  // authenticate, so failing at boot beats failing at the first login.
  AUTH_SECRET: z.string().min(1),

  // Declared, validated, not yet consumed. Items 4 and 11 tighten these.
  LANGFUSE_PUBLIC_KEY: z.string().min(1).optional(),
  LANGFUSE_SECRET_KEY: z.string().min(1).optional(),
  LANGFUSE_BASE_URL: z.url().optional(),
  // Read by docker-compose.yml, like DB_PORT — declared here because the
  // schema is the authoritative key set.
  LANGFUSE_UI_PORT: port.default(3102),
  // Broker surface (005). The dashboard reads the last two; the worker's
  // summariser reads the first two.
  SUMMARY_DEBOUNCE_SECONDS: positiveInt.default(20),
  SUMMARY_BATCH_SIZE: positiveInt.default(10),
  LEADS_PAGE_SIZE: positiveInt.default(25),
  DASHBOARD_LIVE_WINDOW_MINUTES: positiveInt.default(10),

  FOLLOWUP_WINDOW_START: time.default("09:00"),
  FOLLOWUP_WINDOW_END: time.default("20:00"),
  FOLLOWUP_TIMEZONE: z.string().min(1).default("America/Sao_Paulo"),
  FOLLOWUP_FIRST_DELAY_HOURS: positiveInt.default(4),
  FOLLOWUP_MAX_ATTEMPTS: positiveInt.default(3),
});

/**
 * `MODEL_MAX_OUTPUT_TOKENS` is optional in the schema and always present after
 * `loadConfig`, which is what this intersection says.
 */
export type Config = z.infer<typeof configSchema> & { MODEL_MAX_OUTPUT_TOKENS: number };

/** contracts/config.md: 600, or 2000 once reasoning tokens share the budget. */
const OUTPUT_TOKENS_DEFAULT = 600;
const OUTPUT_TOKENS_DEFAULT_THINKING = 2_000;

export const configKeys: string[] = Object.keys(configSchema.shape);

/** Keys with no default — absence stops the process. */
export const REQUIRED_KEYS = [
  "PROVIDER_BASE_URL",
  "PROVIDER_API_KEY",
  "MODEL_ID",
  "DATABASE_URL",
  "AUTH_SECRET",
] as const;

/**
 * Compose passes unset variables through as empty strings rather than omitting
 * them, so a blank value must mean absent — otherwise every optional key would
 * arrive as `""` and every required one would fail for the wrong reason.
 */
function withoutBlanks(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.trim() !== "") result[key] = value;
  }
  return result;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = configSchema.safeParse(withoutBlanks(env));
  if (parsed.success) {
    return {
      ...parsed.data,
      MODEL_MAX_OUTPUT_TOKENS:
        parsed.data.MODEL_MAX_OUTPUT_TOKENS ??
        (parsed.data.MODEL_THINKING ? OUTPUT_TOKENS_DEFAULT_THINKING : OUTPUT_TOKENS_DEFAULT),
    };
  }

  const problems = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${problems}`);
}

let cached: Config | undefined;

/** Parsed once, at the first call in each process — which is boot. */
export function getConfig(): Config {
  cached ??= loadConfig(process.env);
  return cached;
}
