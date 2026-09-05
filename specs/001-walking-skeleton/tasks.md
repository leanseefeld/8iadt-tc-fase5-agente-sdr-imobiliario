---

description: "Task list for the walking skeleton"
---

# Tasks: Walking Skeleton

**Input**: Design documents from `/specs/001-walking-skeleton/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Included. The plan names three suites and the specification's success
criteria are written as assertions, so the tests are the acceptance evidence rather
than an optional extra. They are not written first here: the subject of most of
them is a running container, and a test that cannot run until `docker compose up`
works is not a red-green cycle. `tests/config.test.ts` and
`tests/env-example.test.ts` are the exceptions — pure functions over a schema,
worth writing before the schema is finished.

**Organization**: By user story. Configuration and logging live in Foundational
rather than in their own story phase, because every other story imports them —
which is exactly what the Foundational phase is for.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: different file, no dependency on an incomplete task — safe to run in parallel
- **[Story]**: US1–US4, mapping to the user stories in [spec.md](spec.md)

## Path Conventions

Single project. `src/`, `tests/`, `scripts/` at the repository root, per the
structure in [plan.md](plan.md#source-code-repository-root).

---

## Phase 1: Setup

**Purpose**: Toolchain and skeleton on disk. Nothing runs yet.

- [X] T001 Initialize the project in `package.json` with Next.js 16.3, React 19.2, `zod` 4.5, `pino` 10.3, `drizzle-orm` 0.45 and `pg`, npm as the package manager
- [X] T002 Configure TypeScript `strict` in `tsconfig.json` with the `@/*` path alias mapped to `src/*`, plus `allowImportingTsExtensions` so shared modules can carry explicit `.ts` specifiers for the worker
- [X] T003 [P] Create the full source tree from the plan in `src/` — `agent/`, `channels/`, `domain/`, `jobs/`, `db/migrations/` as `.gitkeep` placeholders
- [X] T004 [P] Configure the dependency rule in `eslint.config.mjs` as `no-restricted-imports` zones: `src/app/**` may not import `src/db/**` or `drizzle-orm`; `src/domain/**` may not import outside `src/domain/**`. Patterns must match both the `@/*` alias and relative forms, so the rule cannot be evaded by switching import style
- [X] T005 [P] Add `.dockerignore` excluding `node_modules`, `.next`, `.git` and `.env`
- [X] T006 [P] Add npm scripts to `package.json`: `dev`, `build`, `start`, `start:worker`, `doctor`, `lint`, `test`
- [X] T007 [P] Add `next.config.ts` with the app configured for standalone output

---

## Phase 2: Foundational

**Purpose**: Configuration and logging. Every story below imports these.

**⚠️ Blocks all user stories.**

- [X] T008 Write `tests/config.test.ts` — table-driven: each required key, when absent or malformed, is rejected with a message naming that key
- [X] T009 [P] Write `tests/env-example.test.ts` — the key set declared by the config schema equals the key set defined in `.env.example`, asserted in both directions
- [X] T010 Implement the Zod schema in `src/core/config.ts` covering every row of [contracts/config.md](contracts/config.md), parsed once at module load, throwing with the offending key named (satisfies T008, T009)
- [X] T011 Extend `.env.example` with `APP_PORT`, `WORKER_HEALTH_PORT` and `WATCHPACK_POLLING`, matching the schema exactly — the Environment Contract gate
- [X] T012 [P] Implement `src/core/logging.ts` as the sole importer of `pino`: JSON to stdout, level from config, `child(bindings)` exposed, no other module imports the logging library
- [X] T013 [P] Define the shared probe result shape and a timeout-bounded probe helper in `src/core/health.ts`, matching [contracts/health.md](contracts/health.md)

**Checkpoint**: config and logging import cleanly and their tests pass under `node --test`.

---

## Phase 3: User Story 1 — One command brings the system up (P1) 🎯 MVP

**Goal**: `docker compose up` starts `app`, `worker` and `db` on a machine with only Docker.

**Independent Test**: Clean clone, `cp .env.example .env`, set the provider key, `docker compose up`. All three services reach running state with no further step.

- [X] T014 [US1] Write the multi-stage `Dockerfile`: `base` installing dependencies on `node:24-alpine`, `dev` running `next dev`, `build` running `next build`, `runner` carrying the standalone output
- [X] T015 [US1] Write `docker-compose.yml` with `app`, `worker` and `db` — `app` and `worker` from the same image differing only by `command`, `postgres:17-alpine` for `db`
- [X] T016 [US1] Add `node_modules` and `.next` as named volumes in `docker-compose.yml`, never bind mounts, per restriction §3
- [X] T017 [US1] Add the `pg_isready` healthcheck to `db` and `depends_on: condition: service_healthy` on `app` and `worker` in `docker-compose.yml` — this is the whole of FR-003, with no retry code in either process
- [X] T018 [P] [US1] Create the placeholder shell in `src/app/layout.tsx` and landing page in `src/app/page.tsx`, copy in pt-BR
- [X] T019 [US1] Implement the worker entrypoint in `src/worker/index.ts`: parse config, start the sweep at `WORKER_SWEEP_INTERVAL_MS` recording `lastSweepAt` and logging at debug, handle `SIGTERM` and `SIGINT` by stopping the timer and draining the pool
- [X] T020 [US1] Verify SC-002 and SC-010 per [quickstart.md](quickstart.md) — cold start under 90 s, source edit visible within 15 s, `WATCHPACK_POLLING=true` as the fallback if the edit does not land
- [X] T021 [US1] Verify SC-011 — set the sweep interval to 5 s and watch three sweeps pass with no errors; verify a stop and start cycle needs no volume cleanup

**Checkpoint**: the system runs. Nothing reports on itself yet.

---

## Phase 4: User Story 2 — Both processes report their own health (P1)

**Goal**: each process answers liveness and readiness for itself, naming any unmet dependency.

**Independent Test**: query all four surfaces with the system up; stop `db` and confirm both processes stay alive, turn not-ready, and name `database` — within 5 seconds.

- [X] T022 [P] [US2] Implement the `pg` pool wrapped by Drizzle in `src/db/client.ts`
- [X] T023 [US2] Implement `checkDatabase()` in `src/services/health.ts` running `SELECT 1` under the timeout helper — the only module that touches `src/db/`
- [X] T024 [P] [US2] Implement liveness in `src/app/api/health/route.ts`, calling no dependency
- [X] T025 [US2] Implement readiness in `src/app/api/health/ready/route.ts` — 200 or 503, calling `services/health.ts`, never importing `db/` directly
- [X] T026 [US2] Implement the `node:http` listener in `src/worker/health-server.ts` on `WORKER_HEALTH_PORT`, serving both paths with `"process": "worker"`
- [X] T027 [US2] Add the `sweep` check to `src/worker/health-server.ts` — fails when `lastSweepAt` is older than three sweep intervals, the constant derived from config rather than a second key
- [X] T028 [US2] Start and stop the health listener from `src/worker/index.ts` alongside the sweep timer
- [X] T029 [US2] Add container healthchecks for `app` and `worker` in `docker-compose.yml`, pointing at the readiness paths
- [X] T030 [P] [US2] Write `tests/health.test.ts` asserting every response conforms to [contracts/health.md](contracts/health.md), failure bodies included
- [X] T031 [US2] Verify SC-009 — stop `db`, confirm liveness stays 200 and both readiness surfaces return 503 naming `database` inside the 5 s bound

**Checkpoint**: an orchestrator could supervise both processes and restart the right one.

---

## Phase 5: User Story 3 — The container reaches the model provider (P2)

**Goal**: prove the container-to-oMLX route once, from inside the container, and write it down.

**Independent Test**: `docker compose exec app npm run doctor` reports reachable; with the key cleared it reports an authentication failure, not a network failure.

- [X] T032 [US3] Implement `scripts/doctor.ts` — `fetch` `/v1/models` using `PROVIDER_BASE_URL` and `PROVIDER_API_KEY`, reporting reachable, authentication-failed and unreachable as three distinct outcomes with distinct exit codes
- [X] T033 [US3] Verify SC-008 and FR-015 — run `doctor` inside the container against a working provider, then with a wrong key, then with oMLX stopped
- [X] T034 [US3] Confirm SC-003 and FR-033 — with oMLX stopped and no observability configuration present, both processes still start and still report **ready**, since neither readiness depends on the provider and nothing is wired to a telemetry backend
- [X] T035 [US3] Record the verified route in `docs/arquitetura/restricoes-de-implantacao.md` §1 with the date and the observed result

**Checkpoint**: the oMLX networking question is closed with evidence, not assumption.

---

## Phase 6: User Story 4 — Configured by environment, legible in logs (P2)

**Goal**: prove the Foundational behaviour end to end in containers.

**Independent Test**: remove a required key and watch the affected process exit naming it; capture a full run's output and confirm every line parses as JSON.

- [X] T036 [US4] Verify SC-007 in containers — `docker compose run --rm -e DATABASE_URL= app npm run start:worker` exits within 10 s naming `DATABASE_URL`
- [X] T037 [US4] Verify SC-004 per [quickstart.md](quickstart.md) — every line from both services across a start-idle-stop cycle parses as JSON and carries timestamp, level, process and message
- [X] T038 [US4] Verify `LOG_LEVEL` suppresses records below the configured level in both processes
- [X] T039 [US4] Verify SC-005 — run `tests/env-example.test.ts` inside the container and confirm it fails when a key is added to the schema alone

**Checkpoint**: all four stories complete.

---

## Phase 7: Polish

- [X] T040 [P] Write the run instructions in `README.md` in pt-BR — prerequisites, `cp .env.example .env`, the provider key, `docker compose up`
- [X] T041 Verify SC-012 — add `import { db } from '@/db/client';` to `src/app/page.tsx`, confirm `npm run lint` **fails**, then revert. A pass here means the rule is decorative
- [X] T042 [P] Verify SC-006 — no secret value anywhere in this branch's history; confirm `.env` is still gitignored
- [X] T043 Run [quickstart.md](quickstart.md) start to finish on a clean clone, confirming SC-001 and SC-013
- [X] T044 Confirm `npm run build` succeeds — with no CI, this is the only type-checking gate

---

## Dependencies & Execution Order

### Phases

Setup → Foundational → US1 → US2 → US3 → US4 → Polish.

The stories are not fully independent, and pretending otherwise would produce a
misleading plan. Specifically:

- **US2 needs US1.** Health surfaces cannot be verified until the containers run.
- **US3 needs US1.** The whole point is running the check *inside* the container.
- **US4 is verification of Foundational**, so its phase is late while its
  implementation is early. This is the one story whose priority and position
  deliberately disagree.

US3 and US4 have no dependency on each other and can be done in either order once
US1 is complete. US4 does not depend on US2.

### Within Phase 2

T008 and T009 before T010, since T010 is written to satisfy them. T011 must land in
the same commit as T010 — that is the Environment Contract gate, and splitting them
is precisely the drift it exists to catch.

### Parallel opportunities

- Setup: T003, T004, T005, T006, T007 all touch different files
- Foundational: T009 alongside T008; T012 and T013 alongside each other
- US1: T018 is independent of the container work
- US2: T022, T024 and T030 are independent of each other
- Polish: T040 and T042 alongside anything

Everything else is sequential, mostly because `docker-compose.yml` and
`src/worker/index.ts` are each touched by several tasks.

---

## Implementation Strategy

**MVP is Setup + Foundational + US1.** At that point the system runs, which is the
single most valuable thing this slice delivers — every later backlog item starts by
running it.

Stop and validate at each checkpoint. US2 is what makes the skeleton supervisable
and is worth doing immediately after; US3 and US4 are verification work that can be
batched.

Commit per task or per logical group. The Environment Contract gate is the one place
where two tasks must share a commit.

## Notes

- Solo project, so `[P]` means "no ordering constraint", not "assign to someone else"
- Nothing in this slice writes to the database beyond `SELECT 1`
- If a task turns out to need a decision listed in `docs/decisoes-pendentes.md`, stop


---

## Implementation notes

Recorded during execution, 2026-09-01. Two of these need a decision.

**T044 runs outside Compose.** `npm run build` inside the `app` service fails —
the dev service shares `.next` with a named volume and a running dev server, and
`next build` into that crashes Next's prerender worker with a misleading
`useContext` error that looks like a code defect and is not one. The gate is
`docker build --target build .`, which has no volumes and is also the image that
would run in the cloud. Both production stages build clean with full type-checking.

**SC-004 does not pass as worded, and cannot.** The worker's output is 100% JSON,
across every cycle tested. The application's is not: 9 of 10 lines on a cold start
are npm's script echo and the Next dev-server banner. Those are framework startup
output, not application log records — every record the application itself emits
through `core/logging.ts` is JSON, which is what FR-023 actually requires.
Recommend narrowing SC-004 to application-emitted records. Not done unilaterally:
it is a success criterion, and weakening one silently at the end of implementation
is exactly the drift the workflow exists to prevent.

**T033 closed on 05/09/2026.** Verified by the developer with the real
`PROVIDER_API_KEY`: `npm run doctor` lists the available models when everything is
set correctly, and reports authentication failure and unreachability as distinct
outcomes. SC-008 and FR-015 are satisfied against a live provider, not a
placeholder.

**Two tasks landed slightly out of order.** `src/db/client.ts` (T022) was written
during US1 because `src/worker/index.ts` drains the pool on shutdown, and writing
that file twice to honour the phase boundary would have bought nothing.

**One file was added that no task called for.** `src/instrumentation.ts` — without
it the application parsed its configuration lazily, on whichever request first
needed it, which is not what FR-019's "validated when each process starts" means.
A misconfigured application would have looked healthy until someone used it.
