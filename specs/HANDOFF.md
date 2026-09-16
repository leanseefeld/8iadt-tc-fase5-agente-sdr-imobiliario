# Orchestrator handoff — 2026-09-08

Written by the outgoing orchestrator for the incoming one. Read this, then
`AGENTS.md`, then the files it points at. Do not re-derive what is settled here.

## Your role

Senior product manager, architect and designer for a solo developer's POC. You do
not write most code yourself: you run one **Opus lead per checkpoint group**, in
the main checkout, and you do the final validation and the merge. The developer
is hands-off and reads only your last message; they want lowest effort, highest
value, no over-engineering, and to be asked only when a spec must change or a
decision is genuinely theirs. The interaction contract and quota rules live in the
project memory (`orchestration-contract.md`); the essentials:

- At most 4 agents in parallel; leads may spawn at most 3 Sonnet subagents.
- Small tasks, one commit per task, so an interruption loses minutes.
- No spec, contract or `docs/` change without the orchestrator's or the
  developer's approval. Leads stop and report when they need one.
- A lead that spawns a subagent pauses and is re-invoked when the child returns;
  its interim "waiting" notifications are not failures. Do not relaunch on those.
- Validate yourself before merging: both test suites, lint, and the real screen
  in the browser. Restart the app container after a merge (Turbopack serves empty
  pages after large file churn).

## State of the repository

| Spec | Branch | Status |
|---|---|---|
| 001 walking skeleton | merged | done |
| 002 data model, seed, catalog | merged | done |
| 003 auth and app shell | merged | done |
| 004 conversation | `004-conversation` (checked out) | groups A, B, C done (T001–T037); **next: group D, T038** |
| 005 broker surface | `005-broker-surface` | spec complete, in worktree `.claude/worktrees/agent-ab036db1c52b8827f` |
| 006 scheduling and follow-up | `006-scheduling-followup` | spec complete, in worktree `.claude/worktrees/agent-a606cc917c841499d` |

Before implementing 005 or 006: `git worktree remove <path>` then `git checkout
<branch>` in the main checkout, `git merge main`, write `.specify/feature.json`.

## How to run spec 004's remaining groups

1. Read `specs/004-conversation/implementation-log.md` (Done, In flight, Next
   step, Gotchas) and `specs/004-conversation/lead-brief.md`.
2. Launch one Opus lead per group with a prompt that says "Read and follow
   `specs/004-conversation/lead-brief.md` to the letter. Your group: …" plus the
   group's exit gate and any group-specific guidance. Groups remaining:
   - **D** T038–T047: `searchProperties` tool, suggestion events, property cards
     in the widget, empty-result copy, `requestHandoff` and `optOut` tools,
     handoff wiring (pause with null holder), `proposeMeeting` paths, message
     budget. Gate: SC-004, SC-006, SC-007 by hand per quickstart.
   - **E** T048–T053: Langfuse tracer with `maskPII`, telemetry on every model
     call, the `observability` Compose profile under a 6 GiB total, Langfuse DB in
     the existing `db` container. Gate: SC-010–012 and the measured memory total
     recorded in `docs/arquitetura/restricoes-de-implantacao.md` §4 (a docs edit —
     you approve it).
   - **F** T054–T058: scenario tests (Cenário 1 and 2 against oMLX), lint, build,
     README, backlog row.
3. After F: validate, merge `--no-ff` into main, mark 004 done in
   `specs/BACKLOG.md`, restart the app, report with a screenshot.

## Decisions taken during 004 that need follow-up

- **Two model calls per turn** (extract with tools, then phrase without tools).
  The developer accepted it. When 004 merges, amend ADR 14's consequences line
  ("one round trip") in `docs/arquitetura/adr/decisoes.md` and note the
  prefix-caching guidance from the lead brief.
- **Thinking mode** (`MODEL_THINKING`) returns empty text on
  `gemma-4-e4b-it-OptiQ-4bit` via oMLX; everything lands in `reasoning_content`.
  Keep it off; retry on the 12B model or a newer oMLX before the demo.
- **Widget quote rule**: the first agent bubble in a test conversation showed the
  WhatsApp-style quote although no newer lead message existed. Have group D
  verify that the quote renders only when a lead message exists after
  `repliesToMessageId`, and fix if not.
- **QA rows**: group C's manual QA left extra leads in the database. For a clean
  demo database: `docker compose down -v && docker compose up -d && docker compose
  exec app npm run db:seed`. Consider a `db:reset` script in group F.
- **Demo model**: GPT-5 on Azure OpenAI via `/openai/v1`; validate by hand before
  the pitch (ADR 16), never in the integration tests.

## Pointers

- Overview page the developer reviewed and approved:
  https://claude.ai/code/artifact/38cffd99-957f-479a-9538-73adbde1ae7d
- Shared contracts between specs: `docs/arquitetura/modelo-de-dados.md` §6–§7.
- Configuration register: `docs/arquitetura/configuracoes.md`.
- Real-time and agent-security design: `docs/arquitetura/visao-geral.md` §8–§9.
- Runtime facts: host has no Node (v10); everything runs via
  `docker compose exec app …`; app http://localhost:3100, worker health :3101,
  widget http://localhost:3100/chat/demo, seeded logins `ana@demo.com.br`,
  `bruno@demo.com.br`, `carla@demo.com.br` / `demo1234`.
