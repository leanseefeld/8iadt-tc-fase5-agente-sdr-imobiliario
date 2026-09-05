# Contract: Environment Configuration

Every value the system reads, in one place. This file, `.env.example` and the Zod
schema in `src/core/config.ts` describe the same set of keys, and
`tests/env-example.test.ts` fails the build if they disagree in either direction.

**Loaded by both processes.** The worker calls the model — it generates follow-up
messages and summaries from item 7 onward — so provider configuration is not
application-only. One schema, parsed once at module load in each process.

**Validation**: a required key that is missing or malformed stops the process at
boot with a message naming the key and the expectation. An optional key with a
default is filled in silently. No value is read from anywhere but the environment.

## Keys

| Key | Type | Required | Default | Read by | Notes |
|---|---|---|---|---|---|
| `PROVIDER_BASE_URL` | URL | yes | — | doctor, item 4 | Container route to the OpenAI-compatible endpoint |
| `PROVIDER_API_KEY` | string, non-empty | yes | — | doctor, item 4 | The one value a clean clone cannot supply itself |
| `MODEL_ID` | string | yes | — | item 4 | Model id or alias as the provider exposes it |
| `MODEL_TIMEOUT_MS` | integer > 0 | no | `30000` | item 4 | |
| `MODEL_MAX_RETRIES` | integer ≥ 0 | no | `2` | item 4 | |
| `DATABASE_URL` | Postgres URL | yes | — | `db/client.ts` | Host is the Compose service name |
| `APP_PORT` | port | no | `3100` | app | Container and published host port — one value moves both |
| `WORKER_HEALTH_PORT` | port | no | `3101` | worker | Introduced by this slice |
| `DB_PORT` | port | no | `55432` | compose | Host port Postgres is published on; inside the network it is always 5432 |
| `WORKER_SWEEP_INTERVAL_MS` | integer > 0 | no | `900000` | worker | Also the basis of the worker staleness threshold |
| `LOG_LEVEL` | enum | no | `info` | both | `trace` `debug` `info` `warn` `error` `fatal` |
| `NODE_ENV` | enum | no | `development` | both | `development` `test` `production` |
| `WATCHPACK_POLLING` | boolean | no | `false` | dev only | macOS file-watching fallback, restriction §3 |
| `AUTH_SECRET` | string | no | — | item 3 | Optional now; item 3 makes it required |
| `LANGFUSE_PUBLIC_KEY` | string | no | — | item 4 | |
| `LANGFUSE_SECRET_KEY` | string | no | — | item 4 | |
| `LANGFUSE_BASE_URL` | URL | no | — | item 4 | |
| `FOLLOWUP_WINDOW_START` | `HH:MM` | no | `09:00` | item 11 | |
| `FOLLOWUP_WINDOW_END` | `HH:MM` | no | `20:00` | item 11 | |
| `FOLLOWUP_TIMEZONE` | IANA zone | no | `America/Sao_Paulo` | item 11 | |
| `FOLLOWUP_FIRST_DELAY_HOURS` | integer > 0 | no | `4` | item 11 | |
| `FOLLOWUP_MAX_ATTEMPTS` | integer > 0 | no | `3` | item 11 | |

Defaults deliberately avoid the common ports — 3000, 5432, 8000, 8001 and 80 —
so the stack can run alongside other projects without stopping them. Every one is
overridable in `.env`.

## Why keys nothing reads yet are declared

`AUTH_SECRET`, the Langfuse keys, the follow-up constants and `DB_PORT` are
validated here before any application code consumes them — `DB_PORT` is read by
Compose rather than by the application at all. That is deliberate: the equality test between schema
and `.env.example` only works if there is one authoritative key set, and the
alternative — letting `.env.example` carry keys the schema has never heard of — is
exactly the drift the gate exists to prevent. They are typed, defaulted and inert.

Items 3, 4 and 11 tighten `required` and `read by` as they consume them. Changing a
row here means changing `.env.example` in the same commit.

## Rules for adding a key

1. Add it to the Zod schema in `src/core/config.ts`.
2. Add it to `.env.example`, with a working default or an empty placeholder if it
   is a secret.
3. Add the row here.

All three in one commit. The test enforces steps 1 and 2; this file is what makes
step 3 reviewable.
