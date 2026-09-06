# Configuration contract — keys added by spec 004

The full contract is the union of this table and
[`001-walking-skeleton/contracts/config.md`](../../001-walking-skeleton/contracts/config.md).
`tests/env-example.test.ts` asserts that the config schema's key set and
`.env.example`'s key set are equal, so the union is enforced rather than trusted.

Every key below MUST land in `src/core/config.ts`, in `.env.example` and in this
table **in the same commit** — the standing Environment Contract gate from 001.

| Key | Required | Default | Read by | Meaning |
|---|---|---|---|---|
| `PROVIDER_AUTH_HEADER` | no | — | `agent/provider.ts` | Header name to carry the API key when the endpoint does not accept `Authorization: Bearer`. The third variable ADR 16 permits; absent means Bearer. |
| `CHAT_HISTORY_WINDOW` | no | `12` | `services/conversation.ts` | Messages of history sent to the model. Older context is the slot state, and later the summary. |
| `CHAT_RATE_LIMIT_PER_MINUTE` | no | `20` | `services/conversation.ts` | Lead messages accepted per conversation per minute. Counted in SQL, so it holds across replicas. |
| `CHAT_POLL_INTERVAL_MS` | no | `5000` | chat widget | How often the widget re-reads history while the conversation is paused for a broker. |
| `TYPING_DELAY_MIN_MS` | no | `300` | `channels/web.ts` | Lower bound of the artificial pause before the first token. |
| `TYPING_DELAY_MAX_MS` | no | `800` | `channels/web.ts` | Upper bound of the same pause. Set both to `0` to disable it in tests. |
| `LANGFUSE_UI_PORT` | no | `3102` | `docker-compose.yml` | Host port the Langfuse UI is published on. Compose-only, declared here because the schema is the authoritative key set — the same reason `DB_PORT` is declared. |

## Keys that change meaning

| Key | Change |
|---|---|
| `MODEL_ID` | The `.env.example` default becomes `gemma-4-e4b-it-OptiQ-4bit`, the development and integration-test model fixed by ADR 16. |
| `MODEL_TIMEOUT_MS`, `MODEL_MAX_RETRIES` | Declared in 001, consumed for the first time here — they now bound a real model call. |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` | Declared in 001, consumed for the first time here. All three unset means no tracer is registered at all, which is FR-037's "identical behaviour". `LANGFUSE_BASE_URL` keeps its `http://langfuse-web:3000` default. |

## Keys deliberately not added

- No key for the model's system prompt or persona. Prompts are code, versioned with
  the code that uses them.
- No key for the slot script, the score weights or the handoff thresholds. They are
  fixed by `modelo-de-dados.md` and ADR 11; making them configurable would make the
  demonstration unreproducible.
- No feature flag for the observability profile. Its presence is the Compose
  profile, and its effect is the three `LANGFUSE_*` keys.
