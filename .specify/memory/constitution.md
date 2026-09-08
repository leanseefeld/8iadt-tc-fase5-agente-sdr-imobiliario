# Real Estate AI SDR Constitution

This constitution governs every specification, plan, task and line of code in this
repository. It supersedes habit, preference and any document outside it.

## Core Principles

### I. Document Authority (NON-NEGOTIABLE)

Not all documents in this repository carry the same weight:

| Location | Status |
|---|---|
| `.specify/memory/constitution.md` | Normative, highest |
| `docs/` | Normative — the real architecture |
| `specs/` | Normative for the feature it describes |
| `reference/` | **NON-NORMATIVE** — ideation only |

`reference/` was written before the technology stack was chosen and describes a
Python/FastAPI system that will not be built. It is valuable for product intent,
user journeys, screen sketches and the pitch narrative. It must **never** be cited
as a technical requirement, and it is not updated to match the implementation.
When `reference/` and `docs/` conflict, `docs/` wins silently — no reconciliation
record is written, because there is nothing to reconcile.

Open questions belong in `docs/decisoes-pendentes.md`. A spec must not invent an
answer to a question that register says is undecided.

### II. Language Boundaries (NON-NEGOTIABLE)

- **English**: all code, identifiers, comments, commit messages, this constitution,
  everything under `specs/`, and `docs/arquitetura/adr/decisoes.md`.
- **Brazilian Portuguese**: `README.md` and the rest of `docs/`.
- **Brazilian Portuguese only**: all UI copy and all agent conversation. There is
  no internationalization framework, no locale switch and no translation keys.
  Strings live directly in the components that render them.

Portuguese domain nouns are translated into English identifiers using the glossary
in `AGENTS.md` — never transliterated, never left in Portuguese. A `Lead` has a
`broker`, not a `corretor`; a search returns `properties`, not `imoveis`.

### III. Modular Monolith

One Next.js application (App Router, TypeScript `strict`). Internal boundaries are
enforced by the dependency rule:

```
app/ → services/ → db/
agent/ → services/
domain/ → (nothing)
```

`domain/` contains pure entities and rules with no I/O, so qualification logic is
testable without a database. There is no repository layer: services own their
Drizzle queries directly.

The worker is a second process launched from the **same image** with a different
command — not a second codebase. The orchestrator is stateless: no process-local
state, ever. All state lives in Postgres.

### IV. One Data Path

Server Components and Server Actions call `services/`. The HTTP API — which exists
for channels, webhooks and the public chat — calls those same services.

**UI code must never import `db/` or Drizzle directly.** This single rule is what
keeps the service boundary real once the internal HTTP hop is gone, and it is the
first thing to check in any review.

### V. Deterministic Slot Machine (NON-NEGOTIABLE)

The qualification state machine is the source of truth, not the model.

- Slot extraction uses structured output against a Zod schema.
- **Deciding what to ask next is deterministic code.** The model never chooses.
- One question per message. Two questions in one message break qualification.
- A filled slot is never asked again.

This matters more with a 4-bit local model than it would with a frontier model,
and it is the difference between a qualification flow and a chatbot that loops.

### VI. Provider Independence

All model access goes through a single factory in `src/agent/provider.ts`, built on
the AI SDK's OpenAI-compatible provider. No other module imports a provider SDK.

Swapping the local oMLX server for a hosted endpoint is a change to
`PROVIDER_BASE_URL` and `MODEL_ID` — and nothing else. Any code that would break
under that swap violates this principle.

### VII. Observability Without Coupling

Every LLM call is traced to Langfuse, capturing at minimum: rendered messages,
model, provider, token counts, latency, tool invocations with their arguments and
results, retry count, error codes, and `lead_id` / `conversation_id` correlation.

Telemetry is **fire-and-forget**. A Langfuse outage must never fail, block or delay
a reply to a lead. Tracing wraps the call; it never gates it.

The concrete span taxonomy is defined by the orchestrator specification, not here.
**Explicit non-goal at this stage: no evals, no scoring harness.**

### VIII. Privacy and PII

PII — name, phone, e-mail, exact address — is masked in application logs *and* in
Langfuse traces. One masking rule, applied at both sinks.

Opt-in is obtained on first contact with the purpose declared. `do_not_contact` is
honored by every outbound path without exception. Anonymization must be possible
without destroying the event history. No secrets in the repository.

### IX. Resilience

- Webhooks are idempotent — a channel redelivery must not produce a second reply.
- Every LLM call has a timeout and a bounded retry, with a generic fallback message
  so a conversation never dies silently.
- Rate limiting per session, and prompt-injection guardrails on lead input. A lead
  asking the agent to ignore its instructions gets a polite refusal, not a discount.

### X. User Experience Discipline

Before creating or changing any screen or component, the author stops and answers,
in the plan or the task, three questions: who is on this screen, what they came to
do, and what the one most reasonable interaction is that gets them there smoothly.
The change is then made for that interaction, not for the convenience of the code.

Every screen has a visible information hierarchy — the summary before the detail,
the primary action distinguishable from the secondary ones at a glance — and a
visual hierarchy that encodes it through size, weight, spacing and position rather
than through decoration. A screen where everything has the same emphasis is a
defect, and so is a control whose effect is not clear from its label.

Interactive state is always fed back: something being processed says so, a lost
connection says so, an empty list explains why it is empty. Where the reference
sketches in `reference/` and this principle disagree, this principle wins.

## Technology Stack

Fixed for this project. Changing any row requires amending this constitution and
recording the decision in `docs/arquitetura/adr/decisoes.md`.

| Layer | Choice |
|---|---|
| Runtime | Next.js (App Router) + TypeScript `strict` |
| Package manager | npm |
| Agent orchestration | Vercel AI SDK |
| Model provider | OpenAI-compatible; oMLX locally |
| Database | PostgreSQL |
| Data access | Drizzle ORM, migrations committed |
| Async work | Postgres `followup_jobs` + append-only `events` outbox |
| Observability | Langfuse |
| Testing | Node's built-in runner (`node:test`), no framework |
| Linting | ESLint flat config with `typescript-eslint` |
| Runtime services | `app`, `worker`, `db` — **no Redis** |

Asynchronous work is polled with `SELECT ... FOR UPDATE SKIP LOCKED`. All
enqueueing goes through a `JobQueue` interface, so a future move to SQS or BullMQ
touches one implementation and nothing else.

## Development Environment

`docker compose up` is the only supported way to run this system — application,
worker and database alike. A developer on any operating system must be able to
clone the repository and run it with Docker and nothing else installed.

Any step that must run on the host is an exception, and every exception requires an
entry in `docs/arquitetura/restricoes-de-implantacao.md` explaining what it is, why
it cannot be containerized locally, and how it is handled in the cloud.

Cloud parity is a design requirement, not an aspiration: every component is a
container that runs both locally and in a cloud container runtime. Configuration
comes from environment variables, logs go to stdout as JSON, and both processes
expose a health endpoint.

## Development Workflow

No production code without a merged specification in `specs/`.

This is a solo-developer project, so there is no review gate — which makes the
automated gates matter more:

1. `/speckit-specify` — write the specification
2. `/speckit-clarify` — resolve ambiguity before planning
3. `/speckit-plan` — technical plan against this constitution
4. `/speckit-tasks` — actionable breakdown
5. `/speckit-analyze` — **required** before implementing
6. `/speckit-implement` — execute

One feature branch per specification. Commit messages in English.

## Governance

This constitution supersedes all other practices. Amendments require editing this
file, recording the reasoning in `docs/arquitetura/adr/decisoes.md`, and bumping the
version below.

Every plan produced by `/speckit-plan` must be checkable against these principles.
Where a specification needs to deviate, it must say so explicitly and justify it —
silent deviation is a defect.

Complexity must be justified. A pattern with exactly one implementation and no
concrete second case is speculative generality, with two deliberate exceptions
recorded in the decision log: `ChannelAdapter` and `JobQueue`, which exist because
they are the seams the architecture argument rests on.

**Version**: 1.2.0 | **Ratified**: 2026-08-30 | **Last Amended**: 2026-09-08
