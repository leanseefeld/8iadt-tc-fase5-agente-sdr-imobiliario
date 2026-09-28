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
(`property-ranking.ts`). That is not five-of-five.

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
