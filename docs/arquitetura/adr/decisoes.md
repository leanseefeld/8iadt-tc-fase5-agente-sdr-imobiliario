# Architecture Decision Record

Consolidated record of the technical decisions taken for this project. One file
rather than one file per decision: most of these are a paragraph or two, and a
single document reads end-to-end for a reviewer while sparing a solo developer
eight files to keep in sync. Further decisions append as new sections.

**Language note:** this file is in English, grouped with the constitution and the
specs as an agent-facing artifact. The rest of `docs/` is in Portuguese.

**Status of all records below: accepted, 2026-08-30.**

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
