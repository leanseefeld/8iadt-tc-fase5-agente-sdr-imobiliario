import { z } from "zod";
import { loadModelProfile, PROFILE_NAME, type ModelProfile } from "./model-profile.ts";

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
/** A comma-separated list of HH:MM, kept in the order written — the order is the preference. */
const timeList = z
  .string()
  .transform((value) => value.split(",").map((part) => part.trim()).filter((part) => part !== ""))
  .pipe(z.array(time).min(1));
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
  // Model — the profile in config/models/ (constitution VI, ADR 23). Every
  // other model setting lives in that file; `.env` names it and holds secrets.
  MODEL_PROFILE: z.string().regex(PROFILE_NAME, "a profile name in config/models/, like omlx_gemma4_e4b"),
  // Where profiles live. Only a test points it elsewhere (a dead provider).
  MODEL_PROFILES_DIR: z.string().min(1).default("config/models"),
  // The keys profiles read, by name. A profile may read no key not declared here.
  OMLX_API_KEY: z.string().min(1).optional(),
  AZURE_OPENAI_BASE_URL: z.url().optional(),
  AZURE_OPENAI_API_KEY: z.string().min(1).optional(),
  MODEL_TIMEOUT_MS: positiveInt.default(30_000),
  MODEL_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
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
  // Read by next.config.ts only: extra hosts allowed to load dev resources,
  // comma-separated (a LAN IP, to open the chat on a phone). Empty is fine.
  DEV_ALLOWED_ORIGINS: z.string().optional(),
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
  // Langfuse's environment for every trace; empty falls back to NODE_ENV. The
  // integration runner sets `test`, so a test run's traces filter apart.
  LANGFUSE_TRACING_ENVIRONMENT: z
    .string()
    .regex(/^[a-z0-9_-]*$/, "lowercase letters, digits, - and _")
    .optional()
    .transform((value) => (value === "" ? undefined : value)),
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
  // Spec 006. Minutes, not hours, so a demonstration shows the sweep working
  // in a few minutes (ADR 15); the production-shaped default is four hours.
  FOLLOWUP_FIRST_DELAY_MINUTES: positiveInt.default(240),
  FOLLOWUP_MAX_ATTEMPTS: positiveInt.default(3),
  // Each unanswered attempt waits this many times longer than the one before.
  FOLLOWUP_BACKOFF_FACTOR: positiveInt.default(3),
  // Due attempts one sweep claims at most.
  FOLLOWUP_BATCH_SIZE: positiveInt.default(20),
  // No meeting is offered sooner than this from now.
  SCHEDULING_MIN_NOTICE_MINUTES: positiveInt.default(120),
  // The hours a proposal tries, in this order, inside each broker's own availability.
  SCHEDULING_PREFERRED_TIMES: timeList.default(["10:00", "14:00", "16:30", "09:00", "11:00"]),
});

/** The parsed environment, plus the model profile it names, resolved. */
export type Config = z.infer<typeof configSchema> & { model: ModelProfile };

export const configKeys: string[] = Object.keys(configSchema.shape);

/** Keys with no default — absence stops the process. */
export const REQUIRED_KEYS = [
  "MODEL_PROFILE",
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
    const { MODEL_PROFILE, MODEL_PROFILES_DIR } = parsed.data;
    let model: ModelProfile;
    try {
      model = loadModelProfile(MODEL_PROFILE, MODEL_PROFILES_DIR, withoutBlanks(env), configKeys);
    } catch (error) {
      throw new Error(`Invalid environment configuration:\n  ${(error as Error).message}`);
    }
    return { ...parsed.data, model };
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

/**
 * Forgets the parsed config, so the next read sees `process.env` as it is then.
 * Only for a test preload that reads the config before the test file sets its
 * own environment (`tests/support/observe.ts`).
 */
export function forgetConfig(): void {
  cached = undefined;
}
