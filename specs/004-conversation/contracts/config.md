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
| `MODEL_THINKING` | no | `false` | `agent/provider.ts` | When true, injects `chat_template_kwargs: { enable_thinking: true }` into the request body (verified on oMLX 08/09/2026); `reasoning_content` never reaches the widget, only the trace. |
| `MODEL_MAX_OUTPUT_TOKENS` | no | `600` (`2000` with thinking) | `agent/provider.ts` | Output token ceiling per call, including reasoning tokens. |
| `MODEL_HISTORY_WINDOW` | no | `12` | `services/conversation.ts` | Messages of history sent to the model. Older context is the slot state, and later the summary. |
| `CHAT_DEBOUNCE_MS` | no | `3000` | `services/conversation.ts` | Silence after the last lead message before a turn claims the conversation — what coalesces a burst into one reply. |
| `CHAT_MESSAGE_BUDGET` | no | `60` | `services/conversation.ts` | Lead messages accepted per session within `CHAT_BUDGET_WINDOW_MINUTES`. Counted in SQL, so it holds across replicas. |
| `CHAT_BUDGET_WINDOW_MINUTES` | no | `30` | `services/conversation.ts` | Rolling window `CHAT_MESSAGE_BUDGET` is counted over. |
| `CHAT_MAX_MESSAGE_CHARS` | no | `1000` | `services/conversation.ts` | Longest single lead message accepted; longer gets the template reply of `contracts/chat-api.md` §2. |
| `CHAT_TYPING_DELAY_MS` | no | `300–800` | `channels/web.ts` | Artificial pause range before the first `chunk` event. Set to `0–0` to disable it in tests. |
| `SSE_PULSE_INTERVAL_MS` | no | `15000` | `app/api/chat/[conversationId]/events/route.ts` | Keep-alive pulse on the SSE stream; two missed pulses trip the widget's "Conexão perdida" state. |
| `LANGFUSE_UI_PORT` | no | `3102` | `docker-compose.yml` | Host port the Langfuse UI is published on. Compose-only, declared here because the schema is the authoritative key set — the same reason `DB_PORT` is declared. |

`CHAT_HISTORY_WINDOW`, `CHAT_RATE_LIMIT_PER_MINUTE`, `CHAT_POLL_INTERVAL_MS`,
`TYPING_DELAY_MIN_MS` and `TYPING_DELAY_MAX_MS` from the pre-review draft of this
contract are gone: debounced coalescing and SSE replaced polling and a per-minute
counter. Every key above is already a row in `docs/arquitetura/configuracoes.md`
(added there in the same commit as `visao-geral.md` §8 and §9) — this table names
which module reads each one, that document is the canonical default and scope.

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
