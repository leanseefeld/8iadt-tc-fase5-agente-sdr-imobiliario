# 015 — implementation log

The overnight work of 30/09/2026 on branch `015-fronteira`. The developer's decisions are on the page
"Fronteira da Sofia" (v2), and summarised in the memory file `overnight-015.md`. **None of them is reopened here.**

## Retomar aqui

**Última atividade:** 2026-09-30T00:25-03:00, by the interactive session.
**Etapa atual:** 3 in progress: the code and the scripted tests are done. Next: the e4b replay of the new conversations, then the turn map.

A session that resumes this work:

1. **Collision check.**
   - If *Última atividade* is **less than 40 minutes ago**, another session is working. Stop without changing
     anything.
   - Otherwise, take over. `git status` may show uncommitted work from a session that halted: review it, keep
     what is coherent, and continue.
   - **When taking over**, first set *Última atividade* to now, then commit and push, so a later scheduled
     session sees you.
2. `git checkout 015-fronteira && git pull --ff-only origin 015-fronteira`.
3. Do the next unchecked stage below. At the end of each stage:
   - update *Última atividade* and *Etapa atual*;
   - commit (message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`);
   - `git push origin 015-fronteira`.
4. Rules:
   - **never merge into main**;
   - e4b for everything, including the full suite (`docker compose exec -T app npm run test:integration`);
   - 12B (`-e MODEL_ID=gemma-4-12B-it-OptiQ-4bit -e MODEL_TIMEOUT_MS=90000`) only for one scenario that failed
     on e4b, to tell model from code;
   - a model failure is logged in `docs/cenarios-de-falha.md`, and the work goes on;
   - a product question the decisions don't cover goes under *Perguntas para a manhã*, and the work moves to
     another stage;
   - don't invent requirements or other specs;
   - document the architecture after changing it (`docs/arquitetura/turno-do-agente.md`, and the Mermaid must
     render).

## Etapas

- [x] **1 · Spec** — `specs/015-fronteira/spec.md`, one page like 009's, written from the decisions, then a
  consistency check against the constitution and the turn map.
- [x] **2 · Scripted-model harness** — `MockLanguageModelV4` from `ai/test` returns the facts JSON a test hands it,
  and the first decision tests run without e4b.
- [ ] **3 · Boundary** — new code in pure modules, not in `run()`:
  - act and remainder in the extraction, with the code safety net for thanks/agreement;
  - the boundary route and the pending offer (yes → handoff; no → guided close);
  - the capability list in the reply prompt, cache-friendly (fixed parts first), with discount becoming an offer;
  - the close: summary by code, courtesy by the model;
  - the turn map updated;
  - new replay conversations (husband, dog, discount, ride, thanks, "outros imóveis"), validated by reading.
- [ ] **4 · Test cleanup** — the list on the page:
  - delete the tests that mirror constants;
  - rewrite the exact-sentence tests to check facts;
  - turn the prompt-text regexes into instruction ids;
  - move the real-model tests to `npm run eval`.
- [ ] **5 · `run()` refactor, if there is time** — move the meeting, change and close decisions into modules,
  with no behaviour change.
- [ ] **6 · Close the night** — full e4b suite, `npm run eval`, the replay read, the failure log updated, and the
  page republished with the report on top. The page is
  https://claude.ai/artifact/33mz8wuQWo3qABXV8xaVFq; a scheduled session can't republish it, so the report
  goes at the end of this file.

## Perguntas para a manhã

*(none yet)*

## Diário

- 2026-09-30T00:18-03:00 · Stage 1: `spec.md` (one page) and `plan.md` (consistency check, design, the decisions I made).
- 2026-09-30T00:20-03:00 · Stage 2: `overrideModel` in `agent/provider.ts` (a test seam); `tests/support/scripted-model.ts` (`MockLanguageModelV4`: extraction answers the scripted facts, the action loop calls the scripted tools, the reply streams a fixed sentence); `tests/integration/scripted-meetings.test.ts` with 3 cases (009 examples 1 and 2, thanks close), 4 s with no model.
- 2026-09-30T00:25-03:00 · Stage 3 (code): `lexicon.ts` (the thanks safety net), `decide/boundary.ts` (act, remainder, offer, outcome), two extraction fields (`messageAct`, `uncovered`), `humanOffer` pending on the metadata, yes → handoff and no → close in `run()`, the close as code summary plus model courtesy, the capability list in the constant reply prompt, and the discount rule moved out of the refusal. Tests: `tests/boundary.test.ts` (tables) and `tests/integration/scripted-boundary.test.ts` (the spec's 7 examples) all pass with no model, in 12 s.
