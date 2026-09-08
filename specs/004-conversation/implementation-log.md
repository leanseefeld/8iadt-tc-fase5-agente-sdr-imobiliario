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

- T018 — `recordLeadMessage` in `src/services/conversation.ts`. The `wip(004)`
  partial from the previous session was reviewed and kept: its shape was right.
  Two things were finished on top of it. First, the lead insert is now
  `on conflict do nothing` plus a re-read, because two tabs opening at once both
  see "no conversation" and both try to create the lead — the loser used to abort
  its whole transaction on `leads_agency_channel_external_unique`. Second, an
  existing lead with no loaded conversation now adopts its latest conversation
  instead of blindly creating a second one. Idempotency is `on conflict do
  nothing` on the message insert against the T014 partial index, never
  catch-and-continue: a raised unique violation aborts the transaction in
  Postgres and would take the lead and conversation created in it along. Three
  refusals happen before anything is written and each costs no model call —
  `tooLong`, `consent`, `budget` (FR-019, FR-032); the pre-consent one is also
  T025's gate, because nothing at all is created for text typed before "Aceito".

- T019/T020 — `src/agent/prompts/{system,fallback}.ts`, one commit because the
  first decides what the second has to cover. `turnSystemPrompt` renders the slot
  state in pt-BR words (never JSON), names the slots filled *this* turn so the
  reply acknowledges before it asks, and quotes the one question `nextQuestion`
  chose. `extractionSystemPrompt` is a separate, voiceless prompt for the
  extraction call. Both are written in Portuguese: instructed in English this
  model answers in English often enough that the language guard would eat the
  reply. `fallback.ts` holds every sentence a lead can read that no model wrote —
  the consent notice and the pre-consent template, budget and length notices,
  the model-failure apology, the two handoff lines, the opt-out confirmation and
  `guardedReply`, which is what goes out when a guard rejects the model's text.

- T021/T022 — `src/agent/tools/{update-slots,scheduling.stub,index}.ts`. The
  advertised schema is `slotsSchema.shape[key].nullish()` per field plus `intent`,
  so a slot has one definition. Everything optional: the model must be able to
  report one slot without inventing eight. `execute` only acknowledges — the
  orchestrator reads the call's *raw* arguments off the stream, because arguments
  that fail the advertised schema never reach `execute`, and with this model those
  are common: `scripts/tool-smoke.ts` returned `intent: "comprar apartamento"` and
  `neighborhoods: "zona sul"` on the very first try. `normalizeExtraction` repairs
  the unambiguous shapes (a string where a list was asked for, `"700 mil"` where a
  number was, a pt-BR word where an enum was) and leaves the rest for `mergeSlots`
  to drop under rule 4. The registry is split by *when* a tool is offered:
  `extractionTools()` is `updateSlots` alone, and the phrasing call gets none —
  given five tools and asked for a sentence, this model picks a tool. The
  scheduling stubs keep `modelo-de-dados.md` §6's signatures exactly
  (`proposeMeeting()` takes no arguments; the viewing/call distinction is decided
  in `domain/handoff.shouldProposeMeeting`, not by the model).

- T023 — `src/agent/recovery.ts`: `plausiblyAnswers` (a greeting, a reaction or an
  emoji is the spec's "noise instead of an answer" and must not cost a call) and
  `recoverSlot`, one `generateObject` over a one-field schema. Two things had to
  change to make it work, both proved by `scripts/recovery-smoke.ts`:
  `generateObject` is the one call whose options are `Omit<RequestOptions,
  'timeout'>`, so FR-014's bound is applied as `AbortSignal.timeout`; and
  `createOpenAICompatible` needs `supportsStructuredOutputs: true` or it sends no
  `response_format` at all and every structured call comes back as
  "response did not match schema". oMLX does support `response_format:
  json_schema` — probed by hand first. With both in place all five Cenário 1
  answers extract correctly in ~0.5–2.5 s each, an order of magnitude better than
  the tool call, which is why recovery is the safety net that carries the turn
  when the tool arrives malformed. `SLOT_HINTS` moved into `prompts/system.ts` so
  the extraction call and the recovery call read a slot the same way; its `intent`
  line writes down the spec's own default (US1 scenario 1 reads "procurando
  apartamento na zona sul" as `purchase`), without which the model guessed
  `investment`.

- T024/T025 — `src/agent/orchestrator.ts` and `tests/integration/turn.test.ts`.
  **The turn is two model calls, not one, and that is the decision to know about.**
  US1 scenario 1 says the question a turn asks is the first still-empty slot
  *after* the lead's message has been read, so the question cannot be computed
  before the extraction — a single call would phrase against the state the turn
  started in and re-ask what the lead just answered. plan.md's "one round trip per
  turn" is therefore wrong and was simplified in the same commit. The four phases
  are: extract (`updateSlots`, `toolChoice: required`, nothing streamed) → merge in
  code (`mergeSlots`, then `recoverSlot` for the pending slot only) → compute
  (score, stage, handoff, meeting, the ONE next question) → phrase (streamed, **no
  tools at all**, guarded per sentence). The phrasing call gets no tools because
  this model, given one, picks it instead of writing the sentence.
  `drain()` only releases a sentence once the buffer ends on its terminator, so a
  guard never judges half a sentence; approved sentences go straight to a
  `ReplySink` (group C attaches SSE to it, `collectingSink()` is the test's). When
  a guard rejects, the stream stops there: nothing approved yet means
  `guardedReply(question)`, something approved but no question asked means the
  deterministic question is sent as one more chunk. A model failure means
  `MODEL_FAILURE_REPLY`, and the turn still commits, so the lead is answered and
  the conversation stays usable (FR-014). `allowedAmounts` is built from
  `figuresIn()` over the lead's own words plus the stored `priceMax`/`ticket` —
  a figure the lead wrote is a figure the agent may repeat. The consent gate is
  in two places on purpose: `recordLeadMessage` refuses pre-consent text, and
  `runTurn` refuses it again, because the worker's consumer reaches a turn without
  passing through the route handler. `commitTurn` now masks tool *arguments*
  rather than the whole tool call — `maskPII` is key-aware and was writing `u***`
  where `updateSlots` belonged.
- **Exit gate for group B passed.** `docker compose exec -e INTEGRATION=1 app node
  --test tests/integration/turn.test.ts` — 15/15, ~2.5–7 s per run. The turn stores
  "Estou procurando apartamento na zona sul", identifies `purchase`, captures
  `zona sul`, asks the `priceMax` question, writes the agent message with
  `repliesToMessageId` on the lead message, and emits `lead.created`,
  `intent.identified` and `conversation.turn` with `actorType: agent`. Observed
  reply: *"Que bacana que você está focada na Zona Sul! Para eu te ajudar melhor,
  qual faixa de preço você tem em mente? 😊"*, with
  `toolCalls: [updateSlots {neighborhoods}, recoverSlot {intent}]` — both halves of
  ADR 14 doing their job in one turn.

- T026/T027 — `src/jobs/{consumers,unanswered-turns}.ts` and the worker sweep.
  `consumers.ts` is `modelo-de-dados.md` §6 signature for signature: `SweepConsumer
  = { name, run({ db, now, log }) }`, exported as an array, iterated by
  `src/worker/index.ts` with a try/catch **per consumer** so one bad consumer costs
  its own sweep and nobody else's — and `lastSweepAt` still moves, or a single bad
  row would take the readiness probe down. §6 gives the file to 005; 004 creates it
  because it needs `unanswered-turns` first, which plan.md's boundary notes already
  allowed. The query is `findUnansweredConversations` in `services/conversation.ts`,
  using the same "newer than the last agent/broker message" predicate `loadTurn`
  uses, so the consumer re-runs exactly the turn the route handler would have. It
  never touches a live turn: `processingSince` newer than `MODEL_TIMEOUT_MS × 2` is
  skipped by the query and refused again by `claimTurn`, both on the same row.
  Verified by restarting the worker: it found 7 conversations with unanswered lead
  messages and committed a turn for each, ~7 s apiece, one of them with the
  `unbackedFigure` guard firing on the model's own invented number.

## In flight
- Nothing.

## Next step
T028 — `ChannelAdapter`, `InboundMessage` and `OutboundMessage` in
`src/channels/types.ts` (group C).

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
- The worker's `unanswered-turns` consumer answers **seeded** demo leads too — they
  have lead messages with no agent reply after them, which is exactly the condition.
  Run `docker compose exec app npm run db:seed` before a demo if the seeded
  conversations need to look untouched.
- `.env` is read by Compose at container start. After changing `MODEL_ID` there, run
  `docker compose up -d` or the running container keeps the old value — `docker
  compose exec -e MODEL_ID=… ` is the one-off workaround.
