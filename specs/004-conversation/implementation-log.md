# Implementation log — spec 004

Recovery file. Every lead updates this in the same commit as the work it
describes, so a fresh lead can resume from `git log` plus this file alone.

## Checkpoint groups

| Group | Tasks | Exit gate | Status |
|---|---|---|---|
| A | T001–T013 (setup, pure core) | `npm test` green with no DB and no model | done |
| B | T014–T027 (turn service, orchestrator, consumer) | one real turn persists against oMLX via the service layer | done |
| C | T028–T037 (channel, notifier, SSE, widget) | widget screenshot; SC-005 reload check | done |
| D | T038–T047 (search tool, cards, handoff, opt-out, budget) | SC-004, SC-006, SC-007 by hand | done |
| E | T048–T053 (Langfuse, observability profile) | SC-010..012; memory total recorded | next |
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

- **Pre-task (group C), `fix(002)`** — the three seeded demo transcripts ended on a
  *lead* message, which is precisely what `unanswered-turns` sweeps for, so the
  worker answered the demo leads on boot (the Gotcha below predicted it). Each
  seeded conversation now closes on the agent: the hot lead's visit confirmation,
  and the script's next question for the warm (neighbourhoods) and cold (bedrooms)
  leads — which is also where those leads actually are, waiting on the lead. The
  demo rows had to be deleted before re-seeding, because `seedLeads` is
  skip-if-exists. The six `test-*` leads group B's integration runs left behind
  were deleted at the same time: they carried unanswered lead messages, so every
  sweep was spending model calls on them. Verified: `docker compose restart worker`
  now logs no "re-running unanswered turns" line and the message count stays 16.

- T028 — `src/channels/types.ts`: `Channel`, `InboundMessage`, `OutboundMessage`,
  `ChannelAdapter` and `InboundMessageError`, per `contracts/chat-api.md` §1.
  `send` returns `Promise<void>` because delivery belongs to the SSE stream, not
  to the request that produced the message — which is what lets spec 006's worker
  send a follow-up through the same method with no request in flight. The error
  class carries the offending field name and no status code: the adapter does not
  know about HTTP.

- T030 — `src/core/notifier.ts`, taken **before** T029 because the web adapter's
  `ReplySink` publishes through it. One `LISTEN` `pg.Client` per process, opened on
  the first `subscribe`, rebuilt with backoff after a drop, plus a map of listeners
  by conversation id. Two channels, and the difference is durability:
  `conversation_message` is rung inside `commitTurn`'s transaction and carries ids
  only (the row exists, so a missed one is recovered by `Last-Event-ID`), while
  `conversation_chunk` carries *text*, because at chunk time no row exists yet —
  it is deliberately lossy and nothing is ever recovered from it. `MESSAGE_CHANNEL`
  moved here and `services/conversation.ts` re-exports it, so the writer and the
  listener cannot drift onto two names. This module is the one place outside `db/`
  and `services/` that opens a Postgres connection: `LISTEN` needs a connection
  held for the life of the process, which is exactly what a pool must not give
  away, and it never reads a row — ids in, ids out — so constitution IV is intact.
  `tests/integration/notifier.test.ts`, 5 tests: two subscribers woken by one
  publish, a third on another conversation left asleep, a chunk carrying its text,
  and unsubscribe stopping delivery.

- T029 — `src/channels/web.ts`: `receive` (a zod parse of `contracts/chat-api.md`
  §2's body, throwing `InboundMessageError` with the offending field and knowing
  nothing about status codes), `send` (one outbound message through the new
  `recordOutboundMessage`), `scheduleTurn` and `notifyingSink`. `text` is optional
  in the schema because the "Aceito" tap is a message with consent and no words.
  The debounce is a per-conversation timer **restarted** by every new lead message,
  which is what makes a burst of three collapse into one reply answering all three
  (FR-043/044); it is `unref`'d so a pending reply never holds a shutdown open.
  On process-local state: the constitution's rule is about the *orchestrator*,
  which still loads from rows and writes back; this timer is scheduling, and if the
  process dies holding one the lead message is already committed and
  `jobs/unanswered-turns.ts` re-runs exactly the turn it would have. The sink
  publishes each approved sentence on `conversation_chunk` and does nothing on
  `done()` — the final bubble is announced by `commitTurn`'s own `NOTIFY`, so the
  write that made it durable is the write that announces it.
  Three reads were added to `services/conversation.ts` in the same commit because
  the routes above need them and services own their queries: `recordOutboundMessage`
  (insert + `lastAgentMessageAt` + optional pause + `NOTIFY`, in one transaction),
  `loadChatHistory` (the whole transcript for a session — deliberately not
  `loadTurn`, which is bounded to `MODEL_HISTORY_WINDOW` because it feeds a prompt)
  and `readMessagesAfter` (FR-048's replay, cursored on the `(createdAt, id)` pair
  every other read here orders by, so "after" means the same thing on both sides of
  a reconnect).

- T031/T032 — `src/app/api/chat/route.ts`, one commit because `GET` and `POST` share
  the cookie and the wire shape. `POST` stores and returns; it never runs a turn in
  the request (FR-042), which is what makes a reply survive the tab closing. All
  four status codes of `contracts/chat-api.md` §2 verified by curl: `400` naming the
  missing field, `404` for an unknown slug, `200` carrying the pre-consent template,
  `202` with the conversation id. A `duplicate` still answers `202` and schedules
  nothing, and a `paused` conversation stores the message and stays quiet.
  Three supporting pieces: `CHAT_SESSION_COOKIE` and `signChatSession`/
  `verifyChatSession` in `src/core/auth.ts` — same key and same primitives as the
  broker session, different cookie and a payload that names an agency and a session
  id but never a user, so nothing in the `(app)` shell can ever be reached with one;
  `src/services/agency.ts` (`findAgencyBySlug`), which both this route and the page
  need for FR-016's 404; and `src/app/api/chat/wire.ts`, the single message shape
  `GET` and the SSE `message` event both emit, so the widget has one bubble renderer
  and `metadata`'s tool calls and guard names never reach a lead. The cookie is
  minted on `POST` and re-minted on `GET`, so a lead whose cookie expired but whose
  `localStorage` id survived gets a stream back without sending anything first.
  Verified: consent tap → `202` + `Set-Cookie`, then "Estou procurando apartamento
  na zona sul" → `202`, and ~20 s later the agent row is in the database
  ("Que legal que você está focada na Zona Sul! 😊 Pra eu te ajudar melhor, qual
  faixa de preço…") — the debounce, the claim and the commit all through HTTP.

- T033 — `src/app/api/chat/[conversationId]/events/route.ts`, the SSE stream.
  **The cookie authorises it, never the URL**: the conversation is derived from the
  signed session and the `conversationId` in the path is only checked for equality,
  so guessing another lead's id buys nothing without the HMAC (`401` with no
  cookie, `403` on a mismatch — both verified by curl). A `message` notification
  carries an id and the row is re-read scoped by the conversation before a byte
  reaches the client; a notification whose `agencyId` is not this stream's is
  dropped, because `NOTIFY` reaches every replica regardless of tenant. Event ids
  are message ids, so `Last-Event-ID` is a cursor into `messages`. Each pulse
  writes both a `: ping` comment (for proxies) and the contract's `pulse` event
  (which the widget counts). Cleanup runs on `request.signal` abort and on
  `cancel()`, and every open stream registers a `goodbye` closure in a
  process-level set drained by a `prependListener` on SIGTERM/SIGINT.
  Verified by curl against a real turn: `retry`/`: open`, `pulse`, three `chunk`
  events as the guards cleared each sentence, then the `message` event carrying the
  persisted bubble and its id, then pulses. Reconnecting with the lead message's id
  as `Last-Event-ID` replayed exactly the agent message that followed.
  **Known limitation, dev server only.** On `docker compose restart app` the
  handler runs and logs `closing SSE streams {streams: 1}` — the frame is enqueued
  — but Next's dev server tears the socket down before the stream's reader pulls
  it, so the `goodbye` does not reach the wire. `next start` drains in-flight
  responses and would; either way the widget sees the connection drop and
  `EventSource` reconnects with its last id, which is the behaviour FR-048 asks
  the *widget* for. Do not "fix" this by writing the goodbye earlier.
  `tests/integration/sse-replay.test.ts`, 7 tests, no model: the cursor returning
  both later messages in order, an id already seen returning nothing, an invented
  id replaying nothing rather than everything, an id from another conversation
  refused as a cursor, `loadChatHistory` returning the whole transcript (SC-005),
  and the HTTP route itself replaying to a reconnecting client. It cleans up its
  own rows, so the demo database stays the demo database.

- T034/T035/T036 — the widget, one commit: `page.tsx`, `ChatWidget.tsx` and
  `chat.module.css` are one screen and reviewing them apart is reviewing nothing.
  **Constitution X, answered before an element was written**: one person, on a
  phone, who tapped an agency link and will decide in ten seconds whether this is
  worth their evening and, later, their phone number; they came to say what they
  want and be understood, not to fill a form; so the transcript is the whole
  screen, the composer sits at the thumb, and the only outright decision the page
  asks for is the consent — first, in the same voice as everything else, one
  button. Every state whose cause is invisible says so in words: enviando,
  recebido, "Carregando a conversa…", the typing dots, "Conexão perdida.
  Reconectando…", "Conversa encerrada".
  The page resolves the tenant and hands down everything else as props — the
  consent wording, the opening question, the pulse interval — so the client bundle
  carries neither `domain/`, nor the prompts, nor the config schema.
  Four decisions worth keeping. (1) The consent notice **stays** after acceptance,
  with "Você aceitou." where its button was: FR-018 says it is the first agent
  message *on open*, and what someone agreed to should not vanish the moment they
  agree. (2) The opening question is *derived* — rendered whenever the lead has
  consented and no persisted message exists yet — not appended on the tap, so it
  survives a reload and disappears the moment a real turn does exist. (3) A
  pre-consent exchange marks the lead's own bubble local as well, so it carries no
  "recebido": nothing was stored and it will not be there after a reload. (4)
  `chunk` events join into one growing bubble and the `message` event then replaces
  it with the stored row — the database is the truth on the client too, which is
  also what makes a `Last-Event-ID` replay idempotent (a `message` whose id is
  already on screen is dropped).
  One thing to hand to group D: the SSE event contract has no conversation status,
  and FR-022's "Falando com um corretor" badge needs one mid-conversation, so the
  widget re-reads `GET /api/chat` **once per completed turn** for `status` alone.
  It is triggered by the stream, not a poll, but if T044 would rather add a status
  to the `message` payload, this is the code to delete.
  Verified in a real browser at 375×812: the consent notice as the first bubble;
  text typed before "Aceito" answered with the fixed template and not persisted;
  "Aceito" → the intent question; "Estou procurando apartamento na zona sul" →
  "recebido", typing dots for ~3 s, then the reply streamed in
  ("Que bacana que você está de olho na Zona Sul, é uma área ótima! Pra te ajudar
  melhor, qual faixa de preço você tem em mente? 😊").

- T037 — **SC-005 verified by hand**, in a real browser at 375x812 against
  `/chat/demo`, on the conversation built in T035's check (consent notice, one lead
  message, one agent reply):
  1. **Reload** — transcript and pending question identical, character for
     character, from `GET /api/chat` alone.
  2. **`docker compose restart app`** (~22 s) — reload again: identical. Nothing
     lived in process memory, so nothing was lost. The widget showed no
     "Conexão perdida" during it, correctly: 22 s is one missed pulse, not two.
  3. **`docker compose stop app` for 40 s** — past two missed pulses, the strip
     appeared and both the input and the send button went disabled (FR-048).
  4. **`docker compose up -d app`** — the strip cleared on its own, with no reload,
     when `EventSource` reconnected and the first pulse arrived.
  5. A second message sent straight after the reconnect — *"Até uns 700 mil"* —
     was answered over the same recovered stream with *"Entendi que seu orçamento
     máximo é de R$ 700.000! Para eu refinar a busca, quantos quartos você
     precisa?"*: the script advanced to the next slot, nothing was re-asked, and
     the figure quoted is the lead's own (the `unbackedFigure` guard's allowed set).

  **Group C's exit gate is passed.**

- T038 — `src/agent/tools/search-properties.ts`. No query of its own: spec 002's
  `services/properties.searchProperties` already ranks, relaxes and returns `[]`
  instead of throwing, so this file only turns the *slot state* into that
  service's criteria, caps the result at three and refuses to run for
  `investment`/`undefined` (FR-024). Two things can never come from a tool
  argument and so are bound by the caller: the `agencyId`, and the intent → the
  `sale`/`rent` transaction. `runSearchProperties` is the code path (the
  orchestrator invokes it like `runProposeMeeting`); `searchPropertiesTool(ctx)`
  is the declared form with an **empty** input schema, offered only through
  `conversationTools(ctx)` — a search tool that cannot exist without a turn is a
  search tool that cannot be aimed at another tenant. `SearchOutcome.relaxable`
  names the ONE filter T041 will offer to relax, widest first
  (neighbourhoods → price → bedrooms).

- T039 — the search wired into `agent/orchestrator.ts`, and the suggestion
  recorded. `commitTurn` already accepted `propertyIds` and emitted
  `properties.suggested` (T017); what was missing was the caller. The search runs
  **once**, on the turn that completes the qualifying script (`qualified` and at
  least one *qualifying* slot filled this turn) and never on a handoff or meeting
  turn — merge rule 1 means those filters can no longer change, so a second
  search would return the same three rows under a second set of cards. Three
  consequences worth keeping: the card prices join `allowedAmounts`, so the
  `unbackedFigure` guard lets the agent repeat a price the catalog returned; the
  script's question waits for the next turn (the cards turn asks which one
  interested them, FR-025) while the guard's `pendingSlot` still previews it; and
  a lead reaction to the cards no longer counts as a fallback — reacting to three
  cards fills no slot, and without that exception a happy conversation walked
  into a handoff two turns after the catalog answered. `phrase()` gained
  `fallbackText` so a guard-rejected cards turn says `SUGGESTION_REPLY` instead
  of "Perfeito, anotado!" under three property cards.

- T040 — `PropertyCard.tsx` (subagent, commit `ace5998`) plus the data path it
  needs, which is the part worth writing down. `contracts/chat-api.md` §3 and §4
  carry **ids**, not rows — a card is a property of the reply, not a copy of the
  catalog embedded in every transcript — so the widget resolves them through a
  new read: `GET /api/chat/properties?agencySlug=…&ids=…`, backed by
  `services/properties.findPropertiesByIds` (scoped by agency, order preserved,
  `isActive` deliberately NOT required, or a delisted imóvel would leave a hole in
  a transcript the lead remembers). `wire.ts` gained `WireProperty`/
  `toWireProperty`, §5's ten fields and nothing else. **No contract shape
  changed**: this is a fourth endpoint next to the three §2–§4 describe, not an
  edit to any of them. It is scoped by slug rather than by the signed cookie
  because these are the same public rows `/catalogo` renders, and a lead whose
  cookie expired should not see a transcript with holes in it.
  The widget resolves each id once and never twice.
  **Group C's follow-up (a), fixed.** The FR-045 quote compared
  `repliesToMessageId` against "the newest lead bubble that has an id", and an
  optimistic bubble has no id until the reload — so on a fresh conversation the
  test was `"<uuid>" !== undefined`, true, and every reply looked like it had
  skipped a message. It now asks the question FR-045 actually asks: is there a
  lead bubble *between* the message this reply answered and the reply itself.

- T041 — the empty result. Landed with T039's commit because it is the same
  branch of the same function: `SearchOutcome.relaxable` picks ONE filter
  (neighbourhoods → price → bedrooms, widest first), `prompts/system.ts` turns it
  into the turn's task ("diga que não encontrou … e pergunte se pode procurar em
  bairros vizinhos"), and `noMatchReply()` is the written version for when a
  guard throws the model's away. No cards are rendered, because `propertyIds` is
  never written when the search returned nothing.

- T043 — `src/agent/tools/{handoff,opt-out}.ts`, both offered on the
  **extraction** call: they report something the lead *said*, so the call that
  reads the lead's message is the call that should notice them. Neither decides
  anything — `domain/handoff.handoffDecision` decides, `commitTurn` writes. With
  `toolChoice: "required"` and three tools the extraction prompt now says which
  is which, and that complaining, disagreeing or changing the subject is
  `updateSlots` with every field null. `HANDOFF_REASONS` was added to
  `domain/handoff.ts` so the tool's enum and the type have one source.

- T044 — the two ways out wired through the turn, and the third defence layer
  that had no task. `handoffDecision` was already called by T024; what was
  missing was opt-out and the input layer.
  **Opt-out** short-circuits the turn: no phrasing call at all, `OPT_OUT_REPLY`
  written verbatim, `commitTurn({ optedOut: true })` setting `doNotContact` and
  `status = closed`. The last thing someone reads from us should not depend on a
  sampler.
  **Handoff** stays where T024 put it and `commitTurn` pauses the conversation
  with `heldByUserId` null, emitting `handoff.requested` with its reason.
  **`src/domain/injection.ts`** is layer 2 of `visao-geral.md` §9, which no task
  named and the exit gate requires: five patterns, checked before the extraction
  call, answering with `refusalReply(pendingQuestion)` and recording
  `metadata.guard = "injectionInput"` — the layer that caught it, in the field
  that already means "which guard fired". It is deliberately *short*:
  `tests/injection.test.ts` asserts it catches attempts 1 and 3 of SC-007 and
  **does not** catch 2, 4 and 5, which belong to the structural and output
  layers. A list that grew until it matched all five would refuse real leads and
  would hide whether the other two layers still hold.
  FR-017's 300–800 ms pause moved into `pauseBeforeFirstChunk`, shared by the
  phrasing path and by both written replies, so a written reply does not arrive
  instantly while every model-written one waits.

- T046 — the budget and the length cap, **verified by hand**. The enforcement was
  already `recordLeadMessage`'s (T018): three refusals before anything is written,
  each answered `200` with a fixed template by the route (T031). What this task
  changed is one sentence: `BUDGET_REPLY` used to promise that a corretor would
  take over, and nothing of the sort happens — no turn, no handoff, no row — so it
  now says only what is true. Verified with `CHAT_MESSAGE_BUDGET=3` and
  `CHAT_MAX_MESSAGE_CHARS=40` in `.env` and `docker compose up -d app`: four
  messages on one session gave `202 202 202` then the budget template with `200`,
  and `select count(*)` over that conversation's lead messages returned **3**; a
  41-character message on a fresh session returned the length template and left
  **0** leads behind — the length check runs before the agency is even resolved.
  `.env` restored and the QA rows deleted afterwards.

- **`fix(004)`, found by the T042/T045 evidence** — two masking defects the
  by-hand run surfaced in `events`, both in code group B wrote and both visible
  only once real payloads were read back:
  1. `conversation.turn`'s payload came out as
     `{"messageId": "d3c4dbdf-fe(90) ****-**41-414f2d326d89"}`. A UUID spends
     exactly the eleven digits a mobile number does, so the phone rule matched
     the middle of an id and corrupted it — and that id is precisely what spec
     005's summariser reads back. `core/security.ts` now cuts UUIDs out of the
     text before the phone scan and puts them back untouched.
  2. `slot.filled` for `name` was stored **unmasked** (`{"slot":"name",
     "value":"Camila"}`), against data-model §4 and FR-031: `commitTurn` used
     `maskText`, which scrubs a phone or an e-mail *inside* free text and has no
     way to know a bare `Camila` is a name. It now masks through
     `maskPII({ [slot]: value })`, whose rule is key-aware — the same rule, via
     the key that names it. `contact` was already fine by accident, because a
     phone number looks like one wherever it is.
  Four tests added to `tests/masking.test.ts`; suite 167 passing, 4 skipped.

- **`fix(004)` — recovery no longer guesses over a good extraction.** T023's own
  rule is "run only when the lead's message plausibly answered the pending slot
  **and no `updateSlots` arrived**"; the code ran it whenever the pending slot was
  still empty. So "Tenho preferência por Moema ou Vila Mariana", answered while
  the script was on `urgency`, produced a fine `neighborhoods` extraction, merge
  rule 1 dropped it as already filled, and the recovery call then guessed
  `urgency: exploring` out of a sentence about bairros. `intent` stays the
  exception, because it is not an answer to a question — every first message
  implies one, and that is the recovery group B's exit gate depends on.
  **Still open (for group F's T054):** when the extraction returns *nothing at
  all*, `recoverSlot` will still answer a question the lead did not answer —
  observed twice, both times filling `urgency` from a message about
  neighbourhoods. `plausiblyAnswers` is too weak a gate on its own, and the fix
  belongs with whoever writes the scenario assertions.

- **Handoff replies are written, not phrased.** The fallback handoff's model
  reply asked a question ("Você gostaria de falar sobre alguma cidade
  específica?") right as the conversation paused — a question nobody was going to
  answer, since the next lead message gets silence until a person arrives. The
  handoff now takes the same shape as opt-out: `fallback.handoffReply(reason)`,
  no phrasing call, both flavours naming the limitation and who is coming. The
  now-unreachable handoff branch of `turnSystemPrompt` was removed rather than
  left as a lie.

- **`domain/injection.looksLikeSteering`** — a second, deliberately WIDER read
  that never refuses anything: it only stops an override attempt being counted as
  a fallback. FR-027 hands over after two turns that learned nothing, and an
  override attempt learns nothing by design, so SC-007's own five scripted
  attempts used to trip the fallback handoff on the second one — the agent had
  understood every one of them and refused. A false positive here costs one
  missed fallback count, which is why it may be wide where `INJECTION_PATTERNS`
  must stay narrow. The turn records `metadata.guard = "steering"` when the
  structural layer simply absorbed the attempt, so every one of the five leaves a
  trace of the layer that answered it.

- T042 — **SC-004 verified by hand.** Cenário 1 through `POST /api/chat` on a
  fresh session, `demo` slug. On the turn that completed the qualifying script the
  agent suggested three codes; the widget rendered three cards at 375×812 with
  photo, title, `R$ 695.000`, quartos, m², bairro/cidade and `Cód. SAU-0005`.
  ```
  select code, price, bedrooms, neighborhood, region, transaction, is_active
    from properties where code in ('SAU-0005','VMA-0002','MOE-0003');
   MOE-0003 | 660000 | 2 | Moema        | zona sul | sale | t
   SAU-0005 | 695000 | 3 | Saúde        | zona sul | sale | t
   VMA-0002 | 665000 | 2 | Vila Mariana | zona sul | sale | t
  ```
  against the slots recorded at search time —
  `{"priceMax": 700000, "bedrooms": 2, "neighborhoods": ["zona sul"], …}`: three
  of three exist, are active, are `sale` (the `purchase` intent), cost at most
  R$ 700.000, have at least 2 quartos and sit in the `zona sul` the lead named.
  `properties.suggested` carries the same three ids.

- T045 — **both `proposeMeeting` paths verified, conversation `active` in both.**
  Purchase: after name and telephone the agent offered a visit —
  `proposeMeeting {kind: viewing, status: notAvailable}`, `status = active`,
  `held_by_user_id` null, lead `qualified` at score 85, and **no**
  `handoff.requested` (FR-040, ADR 19). Investment: the script ended on
  `proposeMeeting {kind: call}`, `status = active`, score 85, and **no**
  `properties.suggested` and no `propertyIds` on any message — the catalog is
  never searched for `investment` (FR-041/FR-024).

- T047 — **SC-006 and SC-007 verified by hand**, per quickstart §3.
  **SC-006**, three fresh sessions:
  · *"Quero falar com um corretor"* → "Claro, já estou chamando um corretor…",
    `status = paused`, `held_by_user_id` null, `handoff.requested {reason: asked}`;
    the widget showed "Falando com um corretor" and the `Corretor` badge.
  · two unintelligible messages → the second reply names the limitation and calls
    a corretor, `fallback_streak = 2`, `handoff.requested {reason: fallback}`.
  · *"Não quero mais receber mensagens"* → the one-sentence confirmation,
    `lead.opted_out`, `do_not_contact = t`, `status = closed`.
  · **Zero further agent messages while paused**: a new lead message on the paused
    conversation was stored and left unanswered for 45 s — past the debounce and a
    worker sweep — because `claimTurn` and `findUnansweredConversations` both carry
    `status = 'active'` in their predicate.
  **SC-007**, a fourth session with `priceMax` and `neighborhoods` already filled:
  five attempts, five refusals, conversation still `active`, and the slot state
  byte-identical before and after (no `slot.filled` event after the first
  injection). No reply quoted a price or a percentage. The layer that answered,
  from `messages.metadata.guard`: `injectionInput` for 1 and 3 (layer 2, no model
  call), `steering` for 2, 4 and 5 (layer 1 — the model refused, nothing moved,
  and no tool ever returned a figure to quote).

- **Group D's exit gate is passed.** Unit suite 169 passing / 4 skipped;
  `npm run lint` and `npx tsc --noEmit` both clean. The QA rows were deleted
  afterwards: the database holds the three seeded demo leads and nothing else.

## In flight
- Nothing.

## Next step
T048 — `src/core/langfuse.ts`, the tracer provider with `maskPII` as its mask (group E).

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
