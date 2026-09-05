# Implementation Plan: Walking Skeleton

**Branch**: `001-walking-skeleton` | **Date**: 2026-09-01 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-walking-skeleton/spec.md`

## Summary

Stand up `app`, `worker` and `db` as containers from one image, each process
reporting its own health, all configuration validated at boot from environment
variables, all output structured JSON on stdout. No business behaviour.

Three decisions shape the whole build: the database wait is a Compose healthcheck
rather than retry code, the provider check is a one-shot diagnostic rather than a
readiness probe, and the dependency rule is a lint zone rather than a convention.
Each removes work the specification would otherwise imply.

Four files carry real logic — `core/config.ts`, `core/logging.ts`,
`services/health.ts`, `worker/index.ts`. Everything else is composition, wiring or
a placeholder directory.

### Spec amendments agreed before planning

Recorded here because the specification is normative and these change it:

| ID | Change | Reason |
|---|---|---|
| FR-012, FR-014 | Provider reachability leaves readiness; becomes the `doctor` diagnostic. Readiness probes the database only. | A provider outage does not make the app unfit to serve traffic. Gating readiness on it contradicts FR-005 and would pull a healthy container out of rotation. |
| FR-027 | Dropped from this slice; moves to backlog item 2. | Zero PII and zero telemetry sinks exist here. A masking seam with no implementations is the speculative generality the constitution's Governance section rejects. |
| FR-025 | Narrowed: `core/logging.ts` is the sole importer of the logging library and supports child bindings. No correlation identifier. | Health checks have no downstream calls to correlate. The seam that matters is the single import point; `AsyncLocalStorage` lands in item 4 with the first real entry points. |
| SC-008 | Verified by running `doctor` inside the container, not by a readiness query. | Follows FR-013's move. |
| SC-012 | Unchanged, but satisfied by an ESLint zone rather than a boundaries plugin. | Same guarantee, fifteen lines. |

`research.md` is deliberately not produced. Its content — the rationale for each
choice — is inline below, where the decision it explains actually lives.

## Technical Context

**Language/Version**: TypeScript 5.x, `strict`. Node 24 LTS (Krypton, current LTS
line as of 2026-08-26) in containers. The host's own Node is irrelevant and unused.

**Primary Dependencies**: Next.js 16.3 (App Router) · React 19.2 · `zod` 4.5 for the
config schema · `pino` 10.3 for structured logging · `drizzle-orm` 0.45 with `pg`
for the database handle. No web framework in the worker — `node:http` directly.

**Storage**: PostgreSQL 17. This slice defines no schema; readiness means the
connection succeeds.

**Testing**: `node:test`, the built-in runner. No test framework dependency, no
config file, runs identically in the container. The suite here is small and
assertion-shaped — a framework would be more setup than subject.

**Target Platform**: Linux containers, `linux/arm64` on the development machine.
Orchestration by Docker Compose locally, any container runtime in the cloud.

**Project Type**: Modular monolith — one Next.js application plus a worker
entrypoint from the same image.

**Performance Goals**: Health surfaces answer within 5 s with a dependency down
(SC-009). Cold start to healthy under 90 s (SC-002). Source edit visible within
15 s (SC-010).

**Constraints**: `docker compose up` is the only supported way to run the system.
Both processes must start with the model provider absent and with no observability
configuration. No Redis.

**Scale/Scope**: Single developer, single machine, ~18 files. Two processes, one
database.

## Constitution Check

*GATE: passed before Phase 0. Re-checked after Phase 1 design — result at the end
of this section.*

| # | Principle | How this slice satisfies it | Verified by |
|---|---|---|---|
| I | Document Authority | Plan cites `docs/` and the spec only. `reference/` is not consulted. Open decision 3 stays deferred per FR-034 — no answer invented. | Inspection |
| II | Language Boundaries | All code, identifiers and this plan in English. The placeholder landing page carries pt-BR copy. No i18n framework. | Inspection |
| III | Modular Monolith | One Next.js app; worker is a second command against the same image. No process-local state beyond the worker's own sweep timestamp, which is a liveness signal, not shared state. | FR-002, T-check in tasks |
| IV | One Data Path | The health route handler calls `services/health.ts`; only that service touches `db/`. The rule is exercised from the first commit rather than asserted. | ESLint zone (FR-032) |
| V | Deterministic Slot Machine | Not applicable — no agent in this slice. | — |
| VI | Provider Independence | Only `scripts/doctor.ts` and, later, `agent/provider.ts` read provider configuration. The diagnostic uses a plain `fetch` against the OpenAI-compatible surface; no provider SDK enters the dependency tree here. | Inspection |
| VII | Observability Without Coupling | Langfuse variables are declared optional in the config schema and read by nothing. Absence changes nothing because there is nothing to be absent from. Deferred by FR-034. | SC-003 |
| VIII | Privacy and PII | No PII exists in this slice. Masking moves to item 2 by the FR-027 amendment. No secrets committed. | SC-006 |
| IX | Resilience | Bounded timeouts on every dependency probe (FR-011). Idempotency, retry and rate limiting attach to surfaces that do not exist yet. | SC-009 |

### Stack and environment gates

| Gate | Status |
|---|---|
| Stack rows unchanged from the constitution's table | Pass — no amendment needed |
| `npm`, not pnpm or yarn | Pass |
| Migrations committed | N/A this slice — item 2 |
| No Redis | Pass |
| `docker compose up` is the only supported entrypoint | Pass |
| Every host-only step recorded in the constraints register | Pass — the provider API key is the only one, already recorded |

### Environment Contract gate (new — standing rule)

**Any environment variable the system reads MUST appear in `.env.example` and in
[`contracts/config.md`](contracts/config.md) in the same commit that introduces
it.**

Convention is not enough here: `.env.example` is the whole of SC-001's
one-command promise, and it rots silently — nothing fails when a variable is added
and left undocumented, until the next clean clone. So the gate is a test, not a
review item.

`tests/env-example.test.ts` parses the keys declared by the config schema and the
keys defined in `.env.example` and asserts the two sets are **equal**. Both
directions matter: a variable read but undocumented breaks a clean clone; a
variable documented but unread is stale configuration that misleads whoever reads
the file next. This is why the schema declares `AUTH_SECRET`, `LANGFUSE_*` and
`FOLLOWUP_*` now as optional values with defaults — they are part of the contract
already, validated but not yet consumed. Items 3 and 11 tighten them.

Cost: one test, roughly twenty lines. It is the cheapest gate in this plan and the
one most likely to earn its keep.

### Post-design re-check

Re-evaluated after Phase 1. No new violations. The Complexity Tracking table below
stays empty: the three amendments removed the only candidates before design
started, and nothing in the design introduces a pattern with a single speculative
implementation. The two seams the constitution explicitly permits — `ChannelAdapter`
and `JobQueue` — are not built here, correctly, since neither has an implementation
in this slice.

## Project Structure

### Documentation (this feature)

```text
specs/001-walking-skeleton/
├── spec.md
├── plan.md              # this file
├── data-model.md        # stub — no persistent data in this slice
├── quickstart.md        # the acceptance script
├── contracts/
│   ├── config.md        # the environment variable contract
│   └── health.md        # health surface shapes for both processes
├── checklists/
│   └── requirements.md
└── tasks.md             # produced by /speckit-tasks
```

### Source Code (repository root)

```text
Dockerfile                          # base → dev → build → runner
docker-compose.yml                  # app · worker · db
.dockerignore
package.json · tsconfig.json · next.config.ts · eslint.config.mjs
.env.example                        # exists; extended by this slice

src/
├── app/
│   ├── layout.tsx                  # placeholder shell, pt-BR
│   ├── page.tsx                    # placeholder landing
│   └── api/health/
│       ├── route.ts                # liveness
│       └── ready/route.ts          # readiness
├── core/
│   ├── config.ts                   # zod schema, parsed once at boot
│   ├── logging.ts                  # sole importer of pino
│   └── health.ts                   # probe helpers, shared shapes
├── db/
│   ├── client.ts                   # drizzle over a pg pool
│   └── migrations/                 # .gitkeep — item 2
├── services/
│   └── health.ts                   # checkDatabase() — the only db/ consumer
├── worker/
│   ├── index.ts                    # entrypoint: sweep loop, signals
│   └── health-server.ts            # node:http listener
├── agent/ · channels/ · domain/ · jobs/    # .gitkeep placeholders
scripts/
└── doctor.ts                       # one-shot provider reachability check
tests/
├── config.test.ts
├── env-example.test.ts
└── health.test.ts
```

**Structure Decision**: the layout fixed by
[`docs/arquitetura/visao-geral.md`](../../docs/arquitetura/visao-geral.md) §3,
created in full with `.gitkeep` placeholders where a slice has not landed. FR-031
exists so that no later slice has to decide where its code goes — that decision was
already made, and an empty directory carries it.

## Shortest implementation path

Ordered by dependency. Each step is small enough to verify before the next begins.

**1 · Scaffold and toolchain.** `npm init`, Next.js 16 App Router with TypeScript
`strict`, the placeholder landing page, the full directory tree with `.gitkeep`.
ESLint config carries the dependency-rule zones from the start, as
`no-restricted-imports` patterns: `app/**` may not import `db/**` or `drizzle-orm`;
`domain/**` may not import anything outside `domain/**`. Fifteen lines of config,
and SC-012 is verified by adding a forbidden import on purpose and watching lint
fail.

**Import convention.** `src/app/**` uses the `@/*` alias, resolved by the Next.js
bundler. Everything the worker loads — `src/core/**`, `src/db/**`,
`src/services/**`, `src/worker/**`, `scripts/**` — uses relative specifiers with
explicit `.ts` extensions, because the worker and the diagnostic run under Node's
native type stripping, which resolves paths but knows nothing about tsconfig
aliases. Two conventions rather than one, for the concrete reason that two
resolvers are involved. The ESLint zones match both forms so the dependency rule
cannot be evaded by switching styles.

**2 · Config and logging.** `core/config.ts` declares one `zod` object covering
every key in `.env.example`, parses `process.env` once at module load, and throws a
message naming the offending variable. `core/logging.ts` wraps `pino` — level from
config, JSON to stdout, a `child(bindings)` passthrough, and no other module ever
imports `pino`. Tests: the schema rejects each required key when absent; the schema
key set equals the `.env.example` key set.

Why `zod` rather than hand-rolled validation: it is already a fixed dependency —
constitution principle V requires structured output against a Zod schema in item 4 —
so this costs nothing and gives typed config for free.

**3 · Database handle and health.** `db/client.ts` exposes a `pg` pool wrapped by
Drizzle. `services/health.ts` runs `SELECT 1` under an `AbortSignal.timeout`, so
FR-011 holds when the database hangs rather than refuses. `core/health.ts` holds the
shared result shape. Drizzle enters now rather than in item 2 because the health
path is the cheapest possible place to prove the `app → services → db` chain works
end to end — which is the whole point of a walking skeleton.

**4 · App health routes.** `/api/health` answers liveness from the process alone,
with no dependency calls, so it cannot be dragged down by a sick database.
`/api/health/ready` calls `services/health.ts` and returns 200 or 503 with the
per-dependency detail in [`contracts/health.md`](contracts/health.md).

**5 · Worker.** `worker/index.ts` is a plain Node entrypoint: parse config, start
the health listener, then `setInterval` at `WORKER_SWEEP_INTERVAL_MS` doing nothing
but recording `lastSweepAt` and logging at debug. `SIGTERM`/`SIGINT` stop the timer,
close the server and drain the pool. Worker readiness is database reachability
**and** `lastSweepAt` newer than three sweep intervals — the only signal that tells
a hung polling loop apart from a healthy one, and it costs one variable.

**6 · Containers.** One `Dockerfile`: `base` installs dependencies, `dev` runs
`next dev`, `build` runs `next build`, `runner` carries the production output. Both
services in `docker-compose.yml` use the same image and differ only by `command`,
which is FR-002 made literal. `node_modules` and `.next` are named volumes, never
bind mounts — restriction §3. `WATCHPACK_POLLING` is exposed as an env var so the
macOS file-watching fallback is a configuration change, not a file edit.

The database wait is `pg_isready` in the `db` healthcheck plus
`depends_on: condition: service_healthy` on both processes. This satisfies FR-003
with **zero lines of application code**; retry loops in the app would be strictly
worse and harder to test.

The `build`/`runner` targets are about ten lines and are not used by the default
`docker compose up`. They stay because "the same image runs in the cloud" is a
claim this slice makes, and because `next build` is the only type-checking gate in
a project with no CI.

**7 · Provider diagnostic.** `scripts/doctor.ts`, run as `npm run doctor` inside
the app container. A `fetch` of `/v1/models` with the configured key, reporting
reachable, authentication-failed, or unreachable as three distinct outcomes
(FR-015). Closes FR-013 and FR-016 and produces the dated register entry, without
putting a provider call on any hot path.

**8 · Documentation.** README start instructions, and the constraints register
entry recording the verified container-to-provider route.

### What is deliberately not built

Retry logic for the database. A logging correlation mechanism. A PII masking seam.
Any Langfuse client. Any migration, table or seed. A test framework. A CI pipeline.
`ChannelAdapter` and `JobQueue`, which the constitution permits as seams but which
have no implementation to seam here.

## Complexity Tracking

No constitution violations. Table intentionally empty.
