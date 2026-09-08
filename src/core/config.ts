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

export const configSchema = z.object({
  // Model provider
  PROVIDER_BASE_URL: z.url(),
  PROVIDER_API_KEY: z.string().min(1),
  MODEL_ID: z.string().min(1),
  MODEL_TIMEOUT_MS: positiveInt.default(30_000),
  MODEL_MAX_RETRIES: z.coerce.number().int().min(0).default(2),

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
  FOLLOWUP_WINDOW_START: time.default("09:00"),
  FOLLOWUP_WINDOW_END: time.default("20:00"),
  FOLLOWUP_TIMEZONE: z.string().min(1).default("America/Sao_Paulo"),
  FOLLOWUP_FIRST_DELAY_HOURS: positiveInt.default(4),
  FOLLOWUP_MAX_ATTEMPTS: positiveInt.default(3),
});

export type Config = z.infer<typeof configSchema>;

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
  if (parsed.success) return parsed.data;

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
