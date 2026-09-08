# Implementation log — spec 004

Recovery file. Every lead updates this in the same commit as the work it
describes, so a fresh lead can resume from `git log` plus this file alone.

## Checkpoint groups

| Group | Tasks | Exit gate | Status |
|---|---|---|---|
| A | T001–T013 (setup, pure core) | `npm test` green with no DB and no model | in flight |
| B | T014–T027 (turn service, orchestrator, consumer) | one real turn persists against oMLX via the service layer | pending |
| C | T028–T037 (channel, notifier, SSE, widget) | widget screenshot; SC-005 reload check | pending |
| D | T038–T047 (search tool, cards, handoff, opt-out, budget) | SC-004, SC-006, SC-007 by hand | pending |
| E | T048–T053 (Langfuse, observability profile) | SC-010..012; memory total recorded | pending |
| F | T054–T058 (scenario tests, lint, build, README) | both suites green, build green | pending |

## Done
- T001 — `ai@7.0.93`, `@ai-sdk/openai-compatible@3.0.44`, `@ai-sdk/react@4.0.96`,
  `@langfuse/otel@5.11.0`, `@langfuse/tracing@5.11.0`, `@opentelemetry/sdk-trace-node@2.11.0`
  pinned exactly. All six versions verified to exist via `npm view` before installing.

## In flight
_(nothing)_

## Next step
T002 — the `test:integration` script.

## Gotchas discovered
- Host has no Node; everything via `docker compose exec app …`.
- Next 16: `cookies()`/`headers()` async; guard file is `src/proxy.ts`; page `searchParams`/`params` are Promises.
- Turbopack dev server can serve empty 200s after large file churn; `docker compose restart app` fixes it.
- oMLX thinking: only `chat_template_kwargs: { enable_thinking: true }` in the request body works; reply then carries `reasoning_content`; raise the output token cap or the answer comes back empty.
