# Architecture Decision Record

Consolidated record of the technical decisions taken for this project. One file
rather than one file per decision: most of these are a paragraph or two, and a
single document reads end-to-end for a reviewer while sparing a solo developer
eight files to keep in sync. Further decisions append as new sections.

**Language note:** this file is in English, grouped with the constitution and the
specs as an agent-facing artifact. The rest of `docs/` is in Portuguese.

**Status: all records below are accepted. Records 1 to 8 were taken on
2026-08-30; later records carry their own date.**

> These decisions stand on their own. None of them exists to "override"
> `reference/`, which is non-normative ideation and was never a competing
> specification.

---

## 1. Next.js + TypeScript + Vercel AI SDK as the runtime stack

**Context.** The project needs a conversational agent with tool calling, a broker
dashboard, and a public chat widget, built by coding agents under a hackathon
deadline by one developer.

**Decision.** A single TypeScript codebase: Next.js (App Router) for both UI and
HTTP surface, Vercel AI SDK for agent orchestration and tool calling.

**Alternatives considered.** Python + FastAPI with a separate frontend has the more
mature AI ecosystem, but splits the project into two languages and two deployment
units for a POC whose UI is half the graded surface. A Node backend separate from
the frontend keeps a cleaner HTTP boundary at the cost of duplicated types and more
plumbing than a solo developer should spend.

**Consequences.** One language, one type system, one build, one deployable image —
shared types between UI and domain with no serialization contract to maintain. The
cost is that Next.js server code is less conventional for long-running agent work
than a plain server, and the worker needs its own entrypoint outside the Next.js
runtime (see decision 2).

---

## 2. Modular monolith, worker as a second entrypoint of the same image

**Context.** Follow-up is a graded scenario, so scheduled background work is not
optional. The architecture is also graded on scalability and componentization.

**Decision.** One application with enforced internal boundaries, plus a worker that
runs from the **same image** with a different command. Not a second codebase, not a
second repository.

**Alternatives considered.** Microservices cost orchestration time and deliver
nothing to a demo. A single process with an in-process scheduler is simpler still,
but ties background work to request-serving capacity and gives up the "replicate
the worker independently" argument the scale story rests on.

**Consequences.** The worker scales independently and can be extracted into its own
service later by changing deployment, not code. The application must stay stateless
for this to hold — which is enforced as constitution principle III. Shared code
between app and worker is free; the discipline required is that neither may reach
past `services/` into the other's concerns.

---

## 3. Drizzle over Prisma

**Context.** Postgres access from TypeScript, with schema written and modified
mostly by coding agents, running in containers.

**Decision.** Drizzle ORM, with migrations committed to the repository.

**Alternatives considered.** Prisma has a larger ecosystem and is better represented
in model training data, which genuinely helps agent-written code. Against that: its
client-generation step adds a build stage that must be repeated inside the container,
and pgvector support — needed if RAG lands — is awkward.

**Consequences.** SQL-shaped queries that read as SQL, no codegen step in the
Docker build, and pgvector reachable through raw SQL when needed. The tradeoff is
less hand-holding than Prisma offers; schema files must be reviewed with more care.

---

## 4. Postgres-backed jobs and outbox; no Redis

**Context.** The system needs scheduled follow-up attempts and asynchronous summary
generation. The ideation material described three incompatible designs at once: a
Redis queue, a `followup_jobs` table, and a timer-driven sweep over conversations.

**Decision.** Postgres only. `followup_jobs` holds scheduled attempts; the
append-only `events` table serves as audit trail, dashboard timeline, metrics source
and integration outbox. The worker polls with `SELECT ... FOR UPDATE SKIP LOCKED`.
Redis is not part of the stack. All enqueueing goes through a `JobQueue` interface.

**Alternatives considered.** Redis with BullMQ gives real retries, backoff and
delayed jobs, and is the more production-shaped answer. For a job that fires at most
three times per lead, it buys a container, a dependency and a set of semantics that
agents must get right, in exchange for capability this workload does not use.

**Consequences.** One less container competing for RAM with local inference, one
less failure mode, and jobs that are transactional with the data that created them —
no dual-write problem between queue and database. `SKIP LOCKED` allows multiple
worker replicas without duplicate processing. Polling latency is bounded by the
sweep interval, which is acceptable for follow-up measured in hours. If volume ever
justifies a broker, `JobQueue` is the single seam to reimplement.

---

## 5. Services as the data path; no repository layer, no internal HTTP hop

**Context.** With Next.js, the dashboard can read the database directly from Server
Components. That would dissolve the layering the architecture argument depends on.

**Decision.** Server Components and Server Actions call `services/`, which is also
what route handlers call. **UI code may never import `db/` or Drizzle.** There is no
`repositories/` layer — services own their queries directly.

**Alternatives considered.** Routing the dashboard through its own HTTP API
preserves a literal network boundary and makes future extraction a pure deploy
change, at the cost of hand-written fetch code and giving up most of what Server
Components offer. A repository layer between services and Drizzle would restore a
familiar shape, but with Drizzle a repository is a function that runs a query —
a layer with no behavior of its own.

**Consequences.** The boundary is the service, not the network: fewer layers, no
serialization tax, and services stay directly testable. The rule is enforceable by
inspection and by lint — a `db/` import under `app/` is a defect. The risk is drift
if that rule goes unchecked, which is why it appears in the constitution, in
`AGENTS.md`, and in this record.

---

## 6. Brazilian Portuguese only; no i18n framework

**Context.** The audience is Brazilian realtors and house seekers. An earlier plan
called for bilingual en/pt-BR support.

**Decision.** UI copy and agent conversation in pt-BR only. No i18n library, no
locale switch, no translation keys. Strings live in the components that render them.
Code stays in English.

**Alternatives considered.** Full bilingual support demos well and forces prompts
out of code into locale files. It also roughly doubles prompt-authoring work and
requires a second pass of conversation QA in a language no target user speaks —
paid for out of a POC budget.

**Consequences.** Substantially less work, and prompt quality effort concentrates in
the one language that matters, which is worth real quality on a 4-bit local model.
The cost is that adding a locale later means retrofitting an i18n layer across every
component. That is accepted: it is a deliberate roadmap item, not an oversight.

---

## 7. GitHub Spec Kit as the spec-driven development framework

**Context.** The project is built almost entirely by coding agents (Claude Code and
Cursor) directed by one developer. Specification quality determines output quality
more than any individual prompt does.

**Decision.** GitHub Spec Kit, installed for both `claude` and `cursor-agent`
integrations so the two agents share one workflow and one constitution.

**Alternatives considered.** A hand-rolled convention would avoid a Python tooling
dependency and fit the project exactly, but means maintaining a workflow instead of
using one. Spec Kit's `uv`/Python requirement is host tooling only and never enters
the application containers.

**Consequences.** A shared workflow across both agents, a constitution that every
plan is checked against, and `/speckit-analyze` as a consistency gate — which
matters disproportionately here, because a solo developer has no reviewer. Skills
install to `.claude/skills/` and `.cursor/skills/`; both must be reinstalled when
the CLI is upgraded.

---

## 8. OpenAI-compatible provider abstraction, oMLX as the local default

**Context.** Development runs against oMLX on Apple Silicon. The demo, and any
cloud deployment, may need a different model entirely.

**Decision.** All model access goes through a single factory in
`src/agent/provider.ts` using the AI SDK's OpenAI-compatible provider. No other
module imports a provider SDK. Provider and model are selected by
`PROVIDER_BASE_URL`, `PROVIDER_API_KEY` and `MODEL_ID`.

**Alternatives considered.** Binding directly to a specific provider SDK would give
access to provider-specific features, at the cost of making the local-to-cloud swap
a code change. A hand-rolled `LLMClient` interface on top of the AI SDK was
considered and rejected as a wrapper around a wrapper — the AI SDK already is the
abstraction.

**Consequences.** Swapping local inference for a hosted endpoint is a configuration
change with no code impact, which is also the mitigation for unreliable tool calling
on quantized local models (see
[`../restricoes-de-implantacao.md`](../restricoes-de-implantacao.md)). The cost is
being limited to the OpenAI-compatible surface — no provider-specific features. For
this project that is not a real limitation.

---

## 9. Node's built-in test runner; ESLint with typescript-eslint

**Accepted 2026-09-05**, during backlog item 1. Amends the constitution's
technology stack table, which previously had no row for either concern.

**Context.** The walking skeleton needed tests for the configuration schema and
the environment contract, and a way to enforce the dependency rule
(`app → services → db`, `domain → nothing`) as something stronger than a
convention. Neither testing nor linting appeared in the stack table, so both were
about to become de-facto choices made by whoever wrote the first test — exactly
the drift the table exists to prevent.

**Decision.** Tests run on Node's built-in runner, `node --test`, with no test
framework. Linting is ESLint's flat config with `typescript-eslint` supplying the
parser only — not its rule presets. The dependency rule lives there as
`no-restricted-imports` zones matching both the `@/*` alias and relative forms.

**Alternatives considered.** Vitest is the conventional answer and would arrive
with watch mode, mocking, coverage and a browser-adjacent environment. For a suite
that is presently twenty-seven assertions over pure functions, it buys a
dependency, a config file and a second module resolver to keep aligned with
`tsconfig.json`. Jest carries the same cost with worse ESM ergonomics. On the lint
side, `eslint-config-next` was considered and rejected for this slice: its flat
config export has moved between releases, and nothing in the slice needed a rule
it provides. Adopting either later is a normal change, not a migration — the tests
are plain assertions and would run unmodified under Vitest.

**Consequences.** Zero test dependencies, no test config file, and the suite runs
identically inside the container and out. `node --test` is weaker where the
project is heading: no built-in mocking beyond `node:test`'s own `mock`, no
snapshot testing, and no watch ergonomics worth the name. The moment that bites —
most likely item 2's database fixtures or item 4's prompt-shaped assertions — is
the moment to revisit this record rather than quietly adding a framework beside
it. Skipping `eslint-config-next` means no Next-specific lint rules; the rule that
actually protects the architecture is ours, and it is verified by deliberately
introducing a forbidden import and watching lint fail.


---

## 10. Agency as tenant from the first migration

**Accepted 2026-09-05.**

**Context.** The pitch claims an architecture that scales to many agencies. The
ideation material has no tenant concept, and retrofitting one after the schema
exists means touching every query.

**Decision.** An `agencies` table, and an `agencyId` foreign key on every
business table (`users`, `leads`, `conversations`, `properties`, `appointments`,
`events`, `followup_jobs`). Every service query is scoped by it. The seed creates
one agency; the public chat resolves it from the widget's route. No per-tenant
configuration, no tenant switching UI.

**Alternatives considered.** Single tenant with a roadmap sentence. Cheaper by one
column per table, and exactly the kind of "we'll add it later" that never happens.

**Consequences.** One extra column and one extra `where` clause everywhere, and a
row-level scoping story that is true rather than aspirational. Cross-tenant
isolation is enforced in services, not in Postgres RLS — a future hardening.

## 11. Deterministic lead score

**Accepted 2026-09-05.** Resolves pending decisions 1 and 5.

**Context.** The score has two consumers — the "qualified" badge and the handoff
trigger — and the jury will ask how it is computed.

**Decision.** A pure function in `domain/` over the slot state, 0 to 100,
recomputed on every turn. Weights and thresholds are documented in
`docs/arquitetura/modelo-de-dados.md` §Score and are the single source. Bands:
cold below 40, warm 40 to 69, hot 70 and above. Handoff triggers are
deterministic: the lead asks for a person; two consecutive fallbacks; or hot with
contact details known. The model never assigns or adjusts the score.

**Alternatives considered.** Model-assigned (richer, unpredictable, refreshes
only when the summary runs) and hybrid (deterministic base plus a model bonus).
Both trade auditability for nuance a POC cannot demonstrate.

**Consequences.** Testable without a model, explainable in one slide, and the
same on a 4-bit local model and a frontier model. Soft signals the model notices
go into the summary's preview line, where a broker can read them, not into the
number.

## 12. Hand-rolled signed session cookie

**Accepted 2026-09-05.** Resolves pending decision 2.

**Decision.** Seeded users with hashed passwords, an HMAC-signed session cookie
built on `AUTH_SECRET`, a route-group guard for `(app)/*`, two roles: `broker`
sees assigned leads, `salesManager` sees the agency's leads and can reassign.
No public sign-up, no password reset, no Auth.js.

**Alternatives considered.** Auth.js credentials provider — more conventional and
OAuth-ready, at the cost of configuration that buys nothing for seeded users.

**Consequences.** Roughly a hundred lines with no dependency beyond a hashing
library. Moving to OAuth later means replacing that module, not the guard.

## 13. Langfuse self-hosted under a memory cap

**Accepted 2026-09-05.** Resolves pending decision 3.

**Decision.** Langfuse v3 runs from a Compose profile (`observability`), off by
default. Memory limits per service sum to **at most 6 GiB**. Langfuse's Postgres
is a second database in the project's existing `db` container. Query latency in
the Langfuse UI is irrelevant; ingestion must not drop spans. Tracing uses the
AI SDK's OpenTelemetry telemetry with the Langfuse OTel exporter, so a Langfuse
outage costs nothing but dropped batches.

**Alternatives considered.** Langfuse Cloud (zero containers, breaks the all-local
promise and needs network during the pitch); stdout-only traces (weakest story).

**Consequences.** The all-local demo holds. The cap is enforced in Compose, and
the constraints register documents the tuning. If the cap proves too tight,
Cloud is a two-variable change.

## 14. Native tool calling under a deterministic slot machine

**Accepted 2026-09-05.**

**Context.** Principle V says code decides what to ask next. That leaves open
whether the model calls tools itself or code drives them. Both JSON structured
output and native tool calling were verified on the local e4b model on
2026-09-05.

**Decision.** Native AI SDK tool calling. Tools: `updateSlots` (structured slot
extraction), `searchProperties`, `proposeViewingSlots`, `bookAppointment`,
`requestHandoff`, `optOut`. Before each model call, code computes the slot state,
the score and **the single next question**, and injects them into the system
prompt. The model phrases; code decides. `updateSlots` results are validated
against the Zod slot schema and a filled slot is never overwritten with null.

**Alternatives considered.** Two calls per turn (extract JSON, then reply) is more
robust on 4-bit models and costs a second round trip; a provider-dependent branch
violates principle VI.

**Consequences.** What was actually built, through spec 004, was not this. Extraction
became JSON asked for in text and parsed by hand, because schema-constrained
output failed on the 4-bit model, and `searchProperties` was invoked from code.
`conversationTools()` existed and was never called. Spec 007 (22/09) is the first
time the turn offers a tool to the model: one tool, `searchProperties`, inside a
bounded loop between extraction and phrasing. Scheduling tools stay declared and
inert. The recovery call for a missed pending slot remains.

## 15. Follow-up constants and the demo trigger

**Accepted 2026-09-05.** Resolves pending decision 4.

**Decision.** Window 09:00 to 20:00 in `America/Sao_Paulo`, fixed for the POC.
Three attempts with growing intervals. The first delay is configured in
**minutes** (`FOLLOWUP_FIRST_DELAY_MINUTES`, replacing the hours key) so a demo
can show it live, plus a "Disparar follow-up agora" action in the lead drawer
that reschedules the pending job for now. The worker still sends it.

**Consequences.** The mechanism is demonstrated, not faked. A seeded stale
conversation exists too, so the dashboard has a recovered lead on first boot.

## 16. Local e4b for development, Azure OpenAI for the demo

**Accepted 2026-09-05.**

**Decision.** `gemma-4-e4b-it-OptiQ-4bit` on oMLX is the development and
integration-test model. The demo runs GPT-5 on Azure OpenAI through its
OpenAI-compatible `/openai/v1` endpoint, which keeps the swap to
`PROVIDER_BASE_URL`, `PROVIDER_API_KEY` and `MODEL_ID`. If that endpoint needs a
different auth header, an optional `PROVIDER_AUTH_HEADER` key is the permitted
third variable — recorded here so it is not a silent deviation from principle VI.

**Consequences.** Every prompt must work on both. Integration tests run against
the local model only; the hosted swap is validated by hand before the pitch.

*The variable list is superseded by record 23 (2026-10-08): a model is now chosen
by `MODEL_PROFILE`. The rest of this record stands.*

## 17. Backlog regrouped into five specs

**Accepted 2026-09-05.**

**Decision.** Backlog items 2 to 12 are regrouped into five specs, each with its
own branch and analyze gate: 002 data model, seed and catalog; 003 auth and app
shell; 004 conversation (orchestrator, chat widget, property search); 005 broker
surface (summary, scoring, dashboard, handoff); 006 scheduling and follow-up.
Deferred items 13 to 16 are unchanged.

**Consequences.** Five spec documents instead of eleven, with the same
traceability columns in `specs/BACKLOG.md`.

## 18. User experience discipline as a constitution principle

**Accepted 2026-09-08.** Amends the constitution to version 1.2.0.

**Context.** The product is graded on interface, clarity and usability, and the
screens are written by coding agents that default to whatever is easiest to
render. Nothing in the constitution said what a good screen is.

**Decision.** Principle X: before creating or editing UI, name the user, their
task and the smoothest interaction; build for that; keep an explicit information
hierarchy and a visual hierarchy that encodes it; always feed back processing,
lost connections and empty states. Mirrored in `AGENTS.md` so it is read even by
agents that never open the constitution.

**Consequences.** Plans for UI slices carry a short "who, what, how" paragraph
per screen, and reviews can reject a screen for flat hierarchy or missing
feedback rather than only for broken code.

## 19. Three state axes, agent-owned booking, SSE over Postgres notifications

**Accepted 2026-09-08**, after the developer's review of specs 002–006.

**Context.** The specs had merged pipeline stage, human takeover and follow-up
exhaustion into one `leads.status`, which made "handoff cannot become
scheduled" a dead end, and had the agent hand a hot lead to a human at the very
moment it should be booking a visit. Real-time delivery was polling.

**Decision.**
- Three independent axes: pipeline stage on the lead (`new → qualifying →
  qualified → scheduled → visited → won | lost`, forward only, broker may set
  won/lost from any stage); conversation state (`active | paused | closed` plus
  `heldByUserId`); follow-up state (`none | pending | exhausted`). Details and
  derived dashboard labels in `modelo-de-dados.md` §7.
- The agent owns the happy path through booking; human takeover is the
  exception (lead asks, two fallbacks, or a broker assumes from the dashboard).
- Real-time delivery is Server-Sent Events fed by Postgres `LISTEN/NOTIFY`:
  one listening connection per replica, notifications carry ids only, the
  server re-reads scoped by agency and conversation before writing to a stream,
  15 s pulse, graceful `goodbye` on SIGTERM, replay from the last event id on
  reconnect. No polling anywhere. Behind a `Notifier` interface so Redis or a
  managed pub/sub is a one-module swap at thousands of tenants.
- Turns are coalesced: one in-flight turn per conversation, 3 s debounce,
  every agent message records `repliesToMessageId`; the widget quotes the
  last-read lead message when newer ones exist. Per-session message budget per
  30-minute window replaces rate limiting; the login rate limit is dropped.
- Events carry `actorType`, `actorUserId` and the Langfuse `traceId`; Langfuse
  session id = conversation id.
- Brokers see the whole agency by default-filtered list ("Meus leads"); they
  carry specializations by intent and a per-weekday availability.
- Thinking mode on oMLX is a config flag injecting `chat_template_kwargs`.

**Alternatives considered.** WebSockets (needs a custom server Next.js does not
provide and adds connection state for no functional gain here); keeping a single
status enum (simpler schema, wrong model).

**Consequences.** Schema gains a handful of columns before any code exists,
which is the cheapest moment. The pitch tells a normal CRM funnel story. The
scalability limits of NOTIFY are documented honestly in `visao-geral.md`.

## 20. The lead score is uncapped and compounding

**Accepted 2026-09-20.** Resolves pending decision 7 and amends ADR 11, whose
weight table and cap at 100 no longer hold. `modelo-de-dados.md` §3 is superseded
and carries a banner saying so; the exact weights are fixed by the spec that
implements this, not here.

**Context.** The score existed to rank a queue, and it stopped doing that. A
finished purchase script with immediate urgency already reached the cap, so every
later signal — the lead pointing at a property, agreeing to a visit — added
nothing. Two leads a broker would treat differently scored the same 100.

**Decision.** Rules, not a formula:

- **No cap.** Signals compound, and the number is open-ended on purpose.
- **Calibration.** A complete purchase script with `urgency = immediate` is
  **100**. Above it, a larger budget scores higher, so 100 is a reference point
  rather than a ceiling.
- **Budget** means the lead's own `priceMax` / `ticket` — what they said they
  would spend — not the price of a property they happened to look at. *(Written
  down as the reading to confirm when the weights are set.)*
- **Rental with a horizon of about two months is hot on its own**, whatever else
  is missing, with a floor of **50**.
- **Booking a viewing or a meeting raises** the score.
- **Asking for a human does not change** it. It is a routing fact, not intent.
- **Temperature bands are re-derived** with the weights: cold/warm/hot cannot
  keep thresholds written for a 0–100 scale.

**Interest for an investor**, who is never shown a property. A brainstorm run
without access to this codebase proposed three declared signals, weighted against
a buyer's interest in a specific property at 1.0: a deployment horizon of six
months or less (**1.0**), capital that is liquid rather than contingent
(**0.8**), and accepting the specialist call with a channel and a time window
(**0.6**). It rejected engagement proxies — message count, message length,
questions asked — on the grounds that they measure free time, not intent. Its own
objection stands beside it: all three are self-reported, where the buyer's signal
is a reaction to a real property, so if most investors state a short horizon the
signal ranks nobody. **Proposal, not yet accepted**; the cheap check before
accepting it is the distribution of stated horizons across real conversations.

**Alternatives considered.** Rebalancing the weights under the existing cap
(keeps 0–100 tidy, but every new signal then has to steal points from an old
one); a model-assigned score (rejected again, for ADR 11's reasons).

**Consequences.** The number stops being a percentage and becomes a rank, which
is what the dashboard needs. Seeded scores, the bands and
`tests/score.test.ts` are all rewritten by the implementing spec. Until then the
dashboard sorts by today's values, which are known to be wrong.

## 21. Sofia says what she is

**Accepted 2026-09-21.**

**Context.** The reply prompt carried the line *"Nunca diz que é uma inteligência
artificial, um modelo ou um assistente"*, and told the model to sound "como uma
pessoa de verdade". The consent notice introduced her as *"consultora da
imobiliária"*. Together those instruct the agent to conceal what it is from
someone it is simultaneously asking for a phone number — and `reference/` L2 had
specified "assistente virtual" in the opening, so this was drift, not a decision.

**Decision.** The agent is honest about being an agent.

- She introduces herself as **"Sofia, assistente virtual da imobiliária"** in the
  consent notice, before the lead has said anything.
- Asked whether she is human, a robot, an AI or an attendant, she answers truthfully
  in one sentence and carries on.
- She never claims to be a person, and never invents a body, an office or a life.
- The widget header reads **"Sofia · assistente virtual"**, which also gives the
  takeover badge its meaning: it flips to "Falando com um corretor" when a human
  actually arrives.

Warmth is unaffected. The voice line now asks for the register of a WhatsApp
conversation rather than for the claim of being a real person.

**Consequences.** "Conversa humanizada" in the challenge statement is read as
*a conversation that does not feel like a form*, never as *a conversation that
passes for human*. Spec 004's US2 title — "a widget that feels human" — is kept
but means the former. Nothing else changes: no tool, no state, no event.

## 22. Revisable qualification state, and actions as tool calls

**Accepted 2026-09-22.** Resolves pending decision 6, which was filed under the
wrong title — what blocks spec 006 is the orchestration, not multi-agency.
Amends **constitution principle V** (one bullet, named below) and extends ADR 14.
Implemented by spec 007.

**Context.** The state model says a conversation has exactly one thing to do:
fill slots. Everything after qualification — navigating, refining, comparing,
asking about a property, rescheduling — has no representation, so it is read as
non-comprehension. Three manifestations were observed in real conversations:

- *"E na zona norte, tem algo?"* after the script finished (16/09,
  `scripts/probe-after-qualification.ts`, e4b local): the lead is walked into a
  handoff at score 100.
- *"Moema ou Vila Mariana"* after *"zona sul"*, mid-script: same outcome.
- *"E a visita de amanhã, continua de pé?"* the turn after a broker handed the
  conversation back (21/09): the lead is returned to a human for having spoken
  about what the human just arranged.

**The mechanism, corrected.** The register recorded this as `mergeSlots`
discarding a value because the slot was already filled. That is not what the code
does: merge rule 1 replaces a filled slot with a different non-empty value. The
defect is one layer up, in the turn's accounting — `MergeResult.filled` counts
only `empty → filled`, so `learnedSomething` cannot see a revision, `notUnderstood`
fires, and two consecutive turns reach the handoff rule. Three consequences follow
from the same gap: `searchDue` keys off the same set and so never re-runs a search
when a criterion changes; `shouldProposeMeeting` is a pure function of slot state
and so re-fires every turn once the script is done; and `cardsJustShown` exists as
a one-turn shield over the symptom.

**Decision.**

- **Every criterion is revisable, `intent` included.** Merge rule 3 (intent moves
  only from `undefined`) is withdrawn. A revision is *learning*, not a
  misunderstanding, and must count as such in the turn's accounting. What happens
  to slots orphaned by an intent change is spec 007's to answer.
- **A filled slot may be asked about again.** Discouraged in the prompt, not
  forbidden in code — a model that notices a lead wants five bedrooms under
  R$ 2.000/month should be able to revisit the budget. This is the one bullet of
  principle V that is amended.
- **Deciding what to ask next stays deterministic code.** The script still tells
  the model, with emphasis, what is left to ask. This bullet of principle V is
  **not** amended, and the topics exploration stays parked.
- **Actions become model tool calls with a round trip before the reply.** The
  model reads a tool result and may call again with different parameters; only
  then is the reply generated. Spec 007 takes the loop and `searchProperties`;
  `proposeMeeting`/`bookMeeting` stay declared and inert until spec 006 supplies a
  calendar.
- **Offering a meeting becomes a suggestion, derived from Postgres.** Whether an
  offer is already live is read from `appointment.proposed` and the message
  record, never from a flag or process memory.
- **Output guards stay.** `EVIDENCE_WORDS` is a candidate to remove whole, but
  only after the new orchestration can be measured — backlog item 17.
- **Every step of the loop is its own span.** Tool name, arguments, result and
  step index, nested under the turn, so a trace reads as an ordered back-and-forth.

**Alternatives considered.** The topics design, where the orchestrator hands over
the remaining topics and the model conducts — parked on 22/09 and kept in
[`exploracoes/roteiro-por-topicos.md`](../../exploracoes/roteiro-por-topicos.md);
it buys revision for free but requires amending principle V's load-bearing bullet
and moves the choice of subject to a 4-bit model. Deterministic phases
(`qualifying → browsing → scheduling`) — compatible with the constitution as
written, but it *adds* machinery where revisability *removes* it. Option 1
unwidened, separating write-once qualification facts from revisable search
criteria — rejected because the split is arbitrary at the boundary and "pode ser
quinta em vez de quarta?" falls on the write-once side.

**Consequences.** `nextQuestion` survives; `cardsJustShown` and part of
`looksLikeSteering` exist to compensate for rigidity and go with it. Multi-agency
returns to backlog item 16 and takes from this decision the input that a
specialist agent likely arrives as a tool call of the main agent, mutating
orchestration state that stays derived from the data model. Rescheduling and
cancelling become spec 009, inside the MVP. The working model becomes
`gemma-4-12B-it-OptiQ-4bit`, for tool-calling reliability; its concurrency is to
be measured rather than assumed.

## 23. Model profiles in YAML

**Accepted 2026-10-08. Amends principle VI (constitution 1.5.0).**

**Context.** Spec 016 put the demo on Azure with four `.env` values. Trying a
second hosted model the same day, gpt-6-luna, showed how much belongs to a model
rather than to the environment: it reasons by default, and the reasoning is paid
from the same output ceiling as the answer. The extraction's fixed 300-token cap
went entirely on reasoning in 13 of 15 calls, and the lead got "tive um problema
técnico". Its fix — a reasoning effort, and ceilings sized for it — is a property
of that model, and so is gpt-5.4-nano's need for nothing of the kind. Switching
between them by editing six variables by hand is where mistakes come from.

**Decision.** One YAML file per model in `config/models/`
(`omlx_gemma4_e4b`, `azure_nano`, `azure_luna_low`, …), loaded by
`core/model-profile.ts` and validated strictly: endpoint (or the name of the key
holding it), the name of the key holding the API key, auth header, model id,
oMLX thinking switch, `reasoning_effort`, and two output ceilings, `reply` and
`extraction`. `.env` holds `MODEL_PROFILE` and the secrets
(`OMLX_API_KEY`, `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_API_KEY`). A profile may
read only keys the config schema declares, so the Environment Contract still
covers every value. `reasoning_effort` stops at `low` (developer): a model that
needs more to follow the script is the wrong model. Tests run on
`omlx_gemma4_e4b` whatever `.env` names (`src/db/test-db.ts`, `app-test`);
`TEST_MODEL_PROFILE` picks another for one run, on purpose. Every model still goes
through `agent/provider.ts` and the OpenAI-compatible provider.

**Alternatives considered.** A `MODEL_REASONING_EFFORT` variable and an
extraction-ceiling variable — two more knobs whose right values depend on which
model the other variables point at, which is the coupling a profile names.
Per-agency model choice — backlog 16, not needed for one agency.

**Consequences.** `PROVIDER_BASE_URL`, `PROVIDER_API_KEY`, `MODEL_ID`,
`PROVIDER_AUTH_HEADER`, `MODEL_THINKING` and `MODEL_MAX_OUTPUT_TOKENS` are gone.
The extraction ceiling rose from 300 to 1024 for models that do not reason
(developer: 300 was too low), and to 4096 for those that do, since the API has one
ceiling per call and cannot keep the reasoning apart from the answer.

