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
- T002 — `npm run test:integration` added; `npm test` still runs only `tests/*.test.ts`.
- T003 — the eleven keys of `contracts/config.md` in `src/core/config.ts` and
  `.env.example`, one commit. `MODEL_ID` now defaults to `gemma-4-e4b-it-OptiQ-4bit`
  in `.env.example` and is set in `.env`. Two shapes worth knowing:
  `CHAT_TYPING_DELAY_MS` parses to `{ minMs, maxMs }`, and `MODEL_MAX_OUTPUT_TOKENS`
  is optional in the schema and defaulted in `loadConfig` (600, or 2000 with
  `MODEL_THINKING`) because its default depends on another key.
- T004 — `tests/slots.test.ts`, 24 tests: SCRIPT order per intent, first-empty-slot
  selection (including a filled slot skipped mid-script), the consent gate on
  `name`/`contact`, `neighborhoods: []` vs `null`, the five `mergeSlots` rules plus
  unknown-key dropping and `MergeResult.filled` ordering, and `isQualified`. Written
  against `src/domain/slots.ts`, which does not exist yet (T007) — the suite is red
  on `ERR_MODULE_NOT_FOUND` until T007–T010 land.
- T005 — `tests/score.test.ts`, 14 tests: the zero/intent-only baseline, each
  qualifying slot's 15 points, `contact`'s 15, the `immediate`/`soon` urgency
  bonuses, the investment bonus (`returnExpectation` filled and not `undecided`
  with `ticket >= 1_000_000`) and its two negative cases, the 100 cap (forced by
  stacking the `soon` and investment bonuses on a fully filled purchase lead — see
  the ambiguity note below), the exact 100/85 fully-filled purchase/investment
  scores, and the 39/40 and 69/70 temperature boundaries. Imports `EMPTY_SLOTS`
  from `src/domain/slots.ts` too, so this suite is red on `ERR_MODULE_NOT_FOUND`
  until both T007 and T008 land.

## In flight
_(nothing)_

## Next step
T006 — the last domain test file, written before its subject.

## Gotchas discovered
- Host has no Node; everything via `docker compose exec app …`.
- Next 16: `cookies()`/`headers()` async; guard file is `src/proxy.ts`; page `searchParams`/`params` are Promises.
- Turbopack dev server can serve empty 200s after large file churn; `docker compose restart app` fixes it.
- oMLX thinking: only `chat_template_kwargs: { enable_thinking: true }` in the request body works; reply then carries `reasoning_content`; raise the output token cap or the answer comes back empty.
