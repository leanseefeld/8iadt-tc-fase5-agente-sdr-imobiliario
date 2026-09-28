# Implementation log — spec 006

## Resume here (written 2026-09-28, before a possible session limit)

**State:** spec, plan, contracts, quickstart and tasks are final and analyzed twice (commit `54275f7` and later on
branch `006-scheduling-followup`). **No code for 006 exists yet.** The next task is **T001**.

**Scope of this run: Phase 1 (T001–T003) and Phase 2 (T004–T010) only.** Then **stop and report to the
developer** — they asked to see the pure scheduling core pass its 200 generated cases before US1 starts. Do not
start Phase 3.

**Before touching anything, check you are not colliding with another session:** if T001–T010 are already all
`[x]` in `tasks.md`, or `git log -1 --format=%cr -- src tests` shows a commit less than 20 minutes old, stop and
do nothing.

**How to work here:**

- Read `AGENTS.md` and `CLAUDE.md` first. The constitution is `.specify/memory/constitution.md` (1.4.0).
- Follow `tasks.md` in order; mark each finished task `[x]`. Commit after each phase with a conventional message
  ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, and push the branch.
- Run tests **in the container**: `docker compose exec -T app npm test`. On the host, test files that import
  services fail at load for unset env — that's not a regression. Typecheck with
  `docker compose exec -T app npx tsc --noEmit`; lint with `docker compose exec -T app npm run lint`.
- The worker does not hot-reload: `docker compose restart worker` after changing code it runs.
- Hard rules from the tasks: every appointment status change goes through **one** transition function;
  `computeOptions` writes nothing and returns **no broker name**; replacing a proposal is **cancel-then-insert**;
  T002's config keys, `.env.example` and `tests/env-example.test.ts` change in **one commit**.
- If a task's wording and the code disagree in a way that changes a requirement, stop and record it here rather
  than choosing.

## Baseline (T001)

*To be filled by T001.*
