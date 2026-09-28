# Implementation log — spec 007

## Baseline (T001)

`docker compose exec app npm test` before any code change: **198 pass, 0 fail, 4 skipped**.
The host figure of 177 pass / 15 fail was not re-run; those 15 are unset
`DATABASE_URL` / `AUTH_SECRET` and were left alone.

## Model (T002, T003, T036a)

`MODEL_ID` stayed `gemma-4-e4b-it-OptiQ-4bit` in `.env.example` and in the
running container. `tests/env-example.test.ts` passed in the baseline.

T003, before code changes, `scripts/tool-smoke.ts`: the model answered in
27991 ms, emitted `updateSlots` with arguments that failed the schema
(`intent: "comprar"`, `neighborhoods` a string), so `execute` did not run, and
still produced a sentence.

T036a skipped. After the search contract was narrowed, a revision turn called
`searchProperties` once (`agent/act` log: `count: 1`, `bounded: false`) and the
catalog search ran. Escalating to 12B would have hidden that.

## What the suite was allowed to change (T057)

- `mergeSlots` now reports `revised` and `intentChanged`. The old test that
  intent never moves between two defined values was replaced. That is FR-002.
- A failed extraction replies with `EXTRACTION_FAILURE_REPLY` and holds the
  streak. `tests/integration/provider-outage.test.ts` expected
  `MODEL_FAILURE_REPLY`. The phrasing-call failure still uses that sentence.

Container unit suite after the slice: **226 pass, 0 fail, 4 skipped**.

Integration, against the container:

- `tests/integration/revision.test.ts` — slot changed, streak reset to 0, search ran, no "não entendi".
- `tests/integration/offer-once.test.ts` — offers `["viewing", null, null]`.
- `tests/integration/handback.test.ts` — re-entry line is in the transcript before the next lead turn, and that turn is not an apology.

## Deliberately not done

**SC-003 (T043a) is deferred.** One revision turn did search. Five runs asserting
the new results match the new criteria were not executed. The catalog already
has Santana in zona norte, and a requested region name now matches as a region
(`property-ranking.ts` — since removed; see FR-034). That is not five-of-five.

**SC-007's trace was not read in Langfuse.** `model.act` is the telemetry
function id, and loop steps are spanned with `step.index` and `step.refused`.
`steps.count` / `steps.bounded` are logged, not written onto the generation,
because the SDK ends that span inside `generateText` before the loop can annotate it.

**The four bring-up cases are uneven.** Obvious: the revision turn, one tool
step. Refusal: an `investment` search returns `searched: false` without calling
the catalog. Bound: `MAX_ACTION_STEPS` is 3 and the call uses `stepCountIs`.
A model that keeps calling until the bound, and a model that retries after an
empty result, were not separate runs.

**Quickstart sections that need the widget** (three phrasings of "como você tá
filtrando?", a person reading three conversations) were not done by hand.

## Concurrency (T053, T054)

Measured on `gemma-4-e4b-it-OptiQ-4bit`, serially. This does not settle the open
claim about the **12B** model. That claim stays open.

N=1: per-request 3339 ms, one tool call executed.
N=4: per-request avg 9855 ms (min 9716, max 9960), wall 9973 ms. About 3× N=1,
so mostly queued, with some overlap. All four requests executed the tool.

## Build

`docker compose exec app npm run lint` passed. `npm run build` failed while
the container's `NODE_ENV=development`, which makes Next prerender
`/_global-error` with `useContext` of null. The script now sets
`NODE_ENV=production` for that command. With that, the build succeeds. Typecheck
was already clean before the script change.

## Closing amendment, 27/09/2026

Two manual conversations (`b0561984…`, `28c0e0e5…`) showed three defects the
requirements had not ruled out. FR-032–FR-035 were added and implemented:

- **FR-032** — `task()` now tries the three search branches before the criteria
  question and the reconfirmation; the orchestrator computes no reconfirmation on a
  turn that searched, so such a turn is never recorded as one.
- **FR-033** — `lastSearchOutcome()` in `services/conversation.ts`, read from the last
  agent message recording a `searchProperties` call; carried as one fact line on
  non-search turns and into the criteria task. `askedAboutCriteria` now also covers
  questions about the results, which keeps them out of the FR-023 cannot-act branch.
- **FR-034** — records the ranking removal already in code; spec 002 bannered.
- **FR-035** — no no-match offers to widen the search; each asks for a new value.


### Replay against the running stack (T066)

Four scripted conversations through `POST /api/chat`, run in parallel on
`gemma-4-e4b` (`4b15c0d7…`, `f911e8cd…`, `048fa70c…`, `37e9aa71…`):

- **SC-012 passed.** *"posso ver até 600k?"* and *"e até 400k?"* searched, found
  nothing, and said so. Neither reply reconfirmed.
- **SC-013 passed.** *"nenhum imóvel nessa faixa?"* was answered with the fact.
  *"tem mais opções?"* after three cards answered that those were the current
  options. No no-match offered to widen the search.
- **Cards won** over a reconfirmation on *"algo em vila mariana?"*. A mid-script
  revision with no search **still reconfirmed**, as FR-032 intends.

The replay also caught two defects against requirements that were already
written, and both are fixed:

- **US1 scenario 6.** *"opa, tá aí?"* while the name was pending: the extraction
  said nothing was attempted, but **recovery** still ran, because it gated only on
  `plausiblyAnswers` ("tá" is not noise). It guessed the name "Opa", and the
  next reply greeted the lead as "Opa". Recovery now also requires
  `attemptedAnswer` (`shouldRecover()`). T012 had kept `plausiblyAnswers` for
  recovery on purpose; that turned out to be one gate too few.
- **US1 scenario 3 / US4's own example.** The reconfirmation restated only the
  dependants, and it is said verbatim, so the value the lead just changed was
  never acknowledged (*"Só pra confirmar: 2 quartos."* after moving the budget to
  1,2 mi). It now names the revised value first:
  *"Só pra confirmar: até R$ 1,2 mi, 2 quartos. Continua assim?"*.

Re-run serially after the fixes (`c221d9a9…`, `006d453a…`): both hold.

**Observation for the concurrency record (T053).** Three replies in the parallel
run had digits glued to the preceding word: *"de2 quartos"*, *"procurando2"*,
*"mostrei3"*. No agent message stored before 27/09 has that pattern, and the
serial re-run produced none. That fits a batched-decoding artifact in the local
server at N=4 rather than an app defect. It is not proven. It adds to the case
that 4-way concurrency on e4b is not free: it came out ~3× slower, and possibly
lossy.

Container suite after: **226 pass, 0 fail, 4 skipped**. Lint and typecheck clean.
