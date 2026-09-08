# Implementation log — spec 004

Recovery file. Every lead updates this in the same commit as the work it
describes, so a fresh lead can resume from `git log` plus this file alone.

## Checkpoint groups

| Group | Tasks | Exit gate | Status |
|---|---|---|---|
| A | T001–T013 (setup, pure core) | `npm test` green with no DB and no model | done |
| B | T014–T027 (turn service, orchestrator, consumer) | one real turn persists against oMLX via the service layer | in progress |
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
- T006 — `tests/reply-guards.test.ts`, 17 tests: `splitSentences` on a
  three-sentence reply; each FR-012 rejection (English, three questions, a
  non-refining second question, an unbacked BRL amount, an unbacked percentage,
  and three leaked-syntax variants — a `toolCall` JSON blob, a `<tool_call>` tag,
  a "system prompt" mention) with its exact `guard` name; the accepted cases
  (the doc's own refining-question example, a next-slot preview, a plain
  one-question reply, a too-short exclamation, and `R$ 850.000` / `850 mil` as
  the same allowed figure); and `createReplyGuard` counting questions across
  sentences rather than per sentence. Written against
  `src/domain/reply-guards.ts` (T009) before it exists — red on
  `ERR_MODULE_NOT_FOUND` until T007–T010 land. Group A (T004–T013) is now fully
  written on the test side; T007–T013 remain to turn it green.

- T007 — `src/domain/slots.ts`: `slotsSchema` (the one code form of the slot state,
  from which the `updateSlots` tool schema will be derived), `SCRIPT`, `QUESTIONS`
  (pt-BR, one per askable), `upcomingSlots`/`nextQuestion`, `mergeSlots` with the five
  rules, `isQualified`/`qualifyingSlots`, and `SLOT_TOPIC_WORDS`/`questionTopics`,
  which `reply-guards.ts` uses to judge a second question. All 24 T004 tests green.
  An explicit `undefined` value is treated exactly like `null` (rule 1), which settles
  the second ambiguity noted below.

- T008 — `src/domain/score.ts`: `scoreLead` and `temperature`, weights exactly as
  `modelo-de-dados.md` §3. All 14 T005 tests green, including the cap case: the
  `+15` high-commitment row is ONE row with two ways to earn it (immediate urgency,
  or a decided investor at `ticket >= 1_000_000`), while `urgency = soon`'s `+5` is a
  separate row — so they can stack and the total is clamped to 100. That resolves the
  first ambiguity noted below in the T005 author's favour.

- T009 — `src/domain/reply-guards.ts`: `splitSentences` (a dot between digits is a
  thousands separator, not a full stop), `createReplyGuard` (streaming, carries the
  question count across chunks) and `checkReply`. Four checks per sentence in order:
  `leakedSyntax`, `language` (pt vs en stopword hits; words common to both languages
  are in neither list), `unbackedFigure` (BRL and percentages parsed from
  `R$ 850.000`, `850 mil`, `1,2 milhão`, `7%`), `questionCount`. All 17 T006 tests
  green; whole suite 123 passing, 0 failing.

- T010 — `src/domain/handoff.ts`: `handoffDecision` (`asked` outranks `fallback`,
  which fires at a streak of 2) and `shouldProposeMeeting` (viewing for a finished
  hot `purchase`/`rental` script with a contact, call for a finished `investment`
  one). Both live in one file so a future trigger cannot be added without reading
  ADR 19's exclusion. `tests/handoff.test.ts` added — plan.md lists it and no task
  did. Note: a finished investment script always scores at least 70, so FR-041's
  point is the KIND of meeting, not a second score threshold.

- T011 — `src/core/security.ts`: `maskText` (a single string; scrubs embedded
  e-mails and phone numbers, leaves everything else alone) and `maskPII` (recursive,
  key-aware masking of arbitrary structures — depth-capped at 8, cycle-guarded,
  never throws). Phone detection is digit-budget-based: two area-code digits plus a
  4-or-5 block plus a 4 block sums to exactly 10 or 11 (12 or 13 only with a literal
  `55` country-code prefix), which is what keeps a `R$ 850.000` price, a four-digit
  year and a CEP's 3+3 split from ever matching, no separate allow/deny list needed.
  Output is normalized to one shape — `(DDD) ****-**XX` / `(DDD) *****-**XX` —
  regardless of whether the input had parens, dashes, spaces or `+55`. Name masking
  is a fixed `first-letter + ***` per word (not length-preserving — the brief's own
  `Camila Duarte` → `C*** D***` example only has 3 stars regardless of word length),
  which is also what makes masking idempotent: a masked name/e-mail/phone does not
  parse as an unmasked one, so re-masking is a no-op. Key matching for the
  name/phone/email/contact rule is a case-insensitive suffix check, so `leadName`
  and `contactPhone` are caught without an explicit list. `tests/masking.test.ts`,
  24 tests: each of the four phone formats plus a 10-digit landline; the price/year/CEP
  non-matches; a bare and an embedded e-mail; `name` and `leadName` keys; `contact`
  holding a phone and holding an e-mail; nested object and array; numbers/booleans/
  null/undefined/Date pass-through; a cyclic object; and masking-twice stability for
  both `maskText` and `maskPII`. Whole suite 156 passing, 0 failing, 4 skipped.

- T012 — `maskPII` wired into `src/core/logging.ts` two ways: `formatters.log`
  masks the merged record (objects, arrays, nested payloads) and a `hooks.logMethod`
  masks string arguments, because `formatters.log` never sees the message itself.
  Verified by hand: `log.info({ leadName, contact, nested: { email } }, "lead
  11987654321 respondeu")` prints `C*** D***`, `(11) *****-**21`, `j***@gmail.com`
  and a masked number inside `msg`. No unit test — pino writes through sonic-boom
  to fd 1, so capturing it would need a destination parameter this logger does not
  take, and the rule itself is covered by `tests/masking.test.ts`.

- T014 — `src/db/migrations/0001_idempotent_inbound.sql`, the partial unique index
  over `(conversation_id, metadata ->> 'clientMessageId')`. Hand-written, not
  generated: drizzle-kit cannot express a partial index over a jsonb expression.
  The journal gained an `idx: 1` entry and `meta/0001_snapshot.json` is a copy of
  the 0000 snapshot with its ids rechained, so a future `db:generate` still diffs
  against the right base. Applied; `pg_indexes` shows
  `messages_client_message_id_uniq`.

- T015 — `loadTurn` in `src/services/conversation.ts`, plus the module's shared
  types. It takes either end of the turn — `{ conversationId }` for the worker,
  `{ agencySlug, externalId }` for the route handler — and returns `null` rather
  than creating anything, because a read must never make a lead. Three queries
  after the join: the last `MODEL_HISTORY_WINDOW` messages (desc then reversed),
  the lead messages newer than the last `agent`/`broker` message (FR-044's
  "answer them together"), and the lead-message count inside
  `CHAT_BUDGET_WINDOW_MINUTES`. `readSlots` parses the stored `jsonb` through
  `slotsSchema` instead of trusting it. `readMessages(conversationId, ids)` is
  here too — it is FR-047's "re-read scoped by conversation" that group C's SSE
  route needs, and it belongs to the same module as the write.

- T016 — `claimTurn`/`releaseTurn`/`staleTurnCutoff`. The claim is the `UPDATE`
  itself: `set processing_since = now where id = ? and status = 'active' and
  (processing_since is null or processing_since < stale)` returning the id. One
  caller's write wins and every other sees zero rows, across replicas, with no
  advisory lock and no read-then-write. `status = 'active'` in the predicate is
  what makes a paused conversation produce no further agent turn (FR-028), and
  the stale cutoff is `MODEL_TIMEOUT_MS × 2` (FR-046).

- T017 — `commitTurn`: one transaction writing the agent message (with
  `repliesToMessageId` = the last unanswered lead message, FR-044), the slots,
  the lead fields, the events of data-model §4 and a closing `pg_notify`. Four
  decisions worth keeping: the claim is released *inside* the same transaction,
  so a crash cannot strand it; the lead's `name`/`phone`/`email` are only ever
  written, never nulled, because merge rule 1 means an absent slot is "unchanged";
  `nextLeadStatus` is forward-only and refuses to move a lead already past
  `qualified` (ADR 19 §7 gives those stages to the broker); and `MESSAGE_CHANNEL`
  = `conversation_message`, payload `{ conversationId, agencyId, messageId }` —
  ids only, which is the contract group C's `core/notifier.ts` listens on.
  Opt-out closes the conversation, a handoff pauses it, everything else leaves
  the status alone.

- T013 — `src/agent/provider.ts`, the only importer of `@ai-sdk/openai-compatible`.
  `getModel()` builds the model lazily; `modelCall()` returns the spreadable
  defaults (`model`, `maxOutputTokens`, `maxRetries`, `timeout`) so a call site
  writes `streamText({ ...modelCall(), messages, tools })` and cannot forget the
  bounds of FR-014. `PROVIDER_AUTH_HEADER` set means the key goes in that header
  and `apiKey` is not passed at all, so there is never a second `Authorization`.
  Thinking is injected through the provider's `fetch` hook — the OpenAI-compatible
  provider has no generic extra-body option, its `providerOptions` are a fixed
  four (`user`, `reasoningEffort`, `textVerbosity`, `strictJsonSchema`).
  `scripts/model-smoke.ts` proves it against the real model — see Gotchas.

## In flight
_(nothing)_

## Next step
T018 — duplicate detection (`recordLeadMessage`) in `src/services/conversation.ts`.

## Ambiguities resolved while writing T004–T006 (frozen API doc did not spell these out)
- **Score cap.** The weight table never states whether the two `+15` bonus
  branches (`urgency === immediate` vs. the investment return/ticket condition)
  can both fire on the same lead. Because `Slots` is one flat type shared by
  every intent, a `purchase` lead can carry non-null `ticket`/`returnExpectation`
  values that were never asked by its script. I assumed the two branches are
  independent additions and wrote the "cap at 100" test by stacking
  `urgency: "soon"` (+5) with a satisfied investment condition (+15) on top of a
  fully filled purchase script (105 uncapped) and asserting `scoreLead` clamps
  it to 100. If T008 clamps or short-circuits differently, this one test may
  need adjusting — everything else in `score.test.ts` follows the table
  unambiguously.
- **`mergeSlots` on an explicit `undefined` value.** Rule 1 says a filled slot
  is never replaced by "null or undefined", but `extraction` keys carrying a
  literal JS `undefined` are indistinguishable from an absent key once the
  extraction has round-tripped through JSON. I tested only the `null` case,
  which is unambiguous, and left the `undefined`-value case untested rather
  than assume which of "no-op, not dropped" vs. "no-op, dropped" T007 will
  implement.

## Gotchas discovered
- Host has no Node; everything via `docker compose exec app …`.
- Next 16: `cookies()`/`headers()` async; guard file is `src/proxy.ts`; page `searchParams`/`params` are Promises.
- Turbopack dev server can serve empty 200s after large file churn; `docker compose restart app` fixes it.
- oMLX thinking: only `chat_template_kwargs: { enable_thinking: true }` in the request body works; reply then carries `reasoning_content`; raise the output token cap or the answer comes back empty.
- Measured on 08/09/2026 through `scripts/model-smoke.ts` with
  `gemma-4-e4b-it-OptiQ-4bit`: `MODEL_THINKING=false` answers in ~11 s / 33 output
  tokens with text. `MODEL_THINKING=true` returns **empty text** and ~1.3 kB of
  `reasoningText` in ~6–7 s / 272–362 output tokens — the whole answer goes to
  `reasoning_content` and the assistant content comes back blank, and it is not the
  token cap (2000 allowed, ~360 used). The provider does map `reasoning_content`
  onto `result.reasoningText`. Keep `MODEL_THINKING=false` for the demo; a turn run
  with it on will produce nothing to send.
- `.env` is read by Compose at container start. After changing `MODEL_ID` there, run
  `docker compose up -d` or the running container keeps the old value — `docker
  compose exec -e MODEL_ID=… ` is the one-off workaround.
