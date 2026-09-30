# 015 — implementation log

The overnight work of 30/09/2026 on branch `015-fronteira`. The developer's decisions are on the page
"Fronteira da Sofia" (v2), and summarised in the memory file `overnight-015.md`. **None of them is reopened here.**

## Retomar aqui

**Última atividade:** 2026-09-30T00:58-03:00, by the interactive session.
**Etapa atual:** 4 done. Next is stage 5 (the `run()` refactor, if there's time) or stage 6.

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
- [x] **3 · Boundary** — new code in pure modules, not in `run()`:
  - act and remainder in the extraction, with the code safety net for thanks/agreement;
  - the boundary route and the pending offer (yes → handoff; no → guided close);
  - the capability list in the reply prompt, cache-friendly (fixed parts first), with discount becoming an offer;
  - the close: summary by code, courtesy by the model;
  - the turn map updated;
  - new replay conversations (husband, dog, discount, ride, thanks, "outros imóveis"), validated by reading.
- [x] **4 · Test cleanup** — the list on the page:
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

1. **Answering from the state.** After a hand back, *"a visita de segunda continua de pé?"* got the offer to
   have the team check it. Sofia knows the answer. The phrasing node never receives the booked meetings: its
   state has only the criteria, and questions no field captures go either to the offer or to "ainda não consigo
   te ajudar" (FR-023). Proposal:
   - the state block given to the phrasing gains **what is booked**, which is a fact like the criteria;
   - a question the state answers gets a phrased answer from the state;
   - the offer stays for what is outside the capability list.

   This touches FR-023's "say so rather than guess", which is why it isn't built without your ok.

## Diário

- 2026-09-30T00:18-03:00 · Stage 1: `spec.md` (one page) and `plan.md` (consistency check, design, the decisions I made).
- 2026-09-30T00:20-03:00 · Stage 2: `overrideModel` in `agent/provider.ts` (a test seam); `tests/support/scripted-model.ts` (`MockLanguageModelV4`: extraction answers the scripted facts, the action loop calls the scripted tools, the reply streams a fixed sentence); `tests/integration/scripted-meetings.test.ts` with 3 cases (009 examples 1 and 2, thanks close), 4 s with no model.
- 2026-09-30T00:25-03:00 · Stage 3 (code): `lexicon.ts` (the thanks safety net), `decide/boundary.ts` (act, remainder, offer, outcome), two extraction fields (`messageAct`, `uncovered`), `humanOffer` pending on the metadata, yes → handoff and no → close in `run()`, the close as code summary plus model courtesy, the capability list in the constant reply prompt, and the discount rule moved out of the refusal. Tests: `tests/boundary.test.ts` (tables) and `tests/integration/scripted-boundary.test.ts` (the spec's 7 examples) all pass with no model, in 12 s.
- 2026-09-30T00:41-03:00 · Stage 3 validated on e4b with the replay (conversations 5–11, by reading).
  - Fixes from it:
    - a guaranteed offer question when the model forgets it (`mustAsk`);
    - `outOfScopeRequest` as a closed positive list (the negative phrasing made e4b refuse the husband and the dog);
    - the remainder excludes what Sofia already does;
    - a bare thanks drops refusal/handoff/opt-out facts the model echoed from the previous message;
    - "outros imóveis" read as the criteria question;
    - with times on the table an ordinal is a pick ("a primeira" had been read as a property card);
    - the "nothing to ask" task no longer invites a next step ("vou buscar…").
  - Broker takeover conversations added (10: offer taken → Ana → hand back; 11: Ana steps in on her own). Both resume naturally, except the one below.
  - **Left for the morning:** after the hand back, "a visita de segunda continua de pé?" gets the team offer, because the phrasing node isn't given the booked meetings in its state. That is a data-flow gap, not a guardrail gap (see *Perguntas para a manhã*).
- 2026-09-30T00:43-03:00 · Stage 3 done. The turn map is updated: the code readings node, the boundary, the pending offer, the close (code summary plus model courtesy), the capability list, and the 015 state machine. Both Mermaid diagrams parse and render (mermaid 11).
- 2026-09-30T00:58-03:00 · Stage 4 done.
  - Deterministic suite (`npm run test:integration`): 395/395 in 58 s. It took ~7 min with e4b.
  - `npm run eval` (e4b): 11 files, 58 tests, 6 min. The first run failed 2:
    - booking: "não vou mais poder" read as a reschedule. That's the model; it passed on rerun.
    - meeting-escapes: **a defect of mine**. After a boundary offer ("vocês trabalham com financiamento?"), "pode ser a primeira opção" was read as a yes and handed off. The offer's answer now counts only when the message does nothing else the turn handles. There's a scripted test for it. Rerun: both files pass.
