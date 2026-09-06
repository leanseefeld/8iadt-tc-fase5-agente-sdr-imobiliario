# Quickstart: Scheduling and Follow-up

Runs against `docker compose up`, from a shell with `docker compose exec app …`.
Assumes specs 002–005 are merged (seed, auth, conversation, broker surface).

## 0 · Demonstration configuration

Set these in `.env` for a fast demo loop instead of the production-shaped
defaults in `.env.example`:

```
FOLLOWUP_FIRST_DELAY_MINUTES=1
WORKER_SWEEP_INTERVAL_MS=5000
```

Restart the worker after changing `.env`: `docker compose restart worker`.

## 1 · Propose and book (US1)

1. Open the widget, qualify a lead to the point of interest (fill the script's
   slots for `purchase` or `rental`).
2. Confirm the next agent message carries up to three dated options — never a
   question asking for a preferred time.
3. Reply with the second option's number. Confirm the reply is a compact card
   naming weekday, date, time, type and — if a property was in play — its code.
4. Open `/agenda` as that lead's broker; confirm the appointment appears today or
   on its date, ascending by time within its day group.
5. Repeat steps 1–3 for a second lead assigned to the same broker at the same
   hour; confirm the second attempt fails with a reason and offers new options.

## 2 · The follow-up sweep (US2 — the graded scenario)

1. Answer two qualification questions in the widget, then stop replying.
2. With the demo delay set, wait just over a minute; watch the worker log for a
   `followup` consumer line reporting `sent`.
3. Reopen the widget (or `GET /api/chat`): the new agent message names a concrete
   detail from the conversation (the neighborhood or price ceiling already given)
   and ends with the same question that was pending.
4. Reply anything. Confirm no further follow-up arrives, and that
   `services/followup.ts`'s cancellation ran — check the `events` table for
   `followup.recovered`.
5. Repeat without replying, across the configured `FOLLOWUP_MAX_ATTEMPTS`;
   confirm the lead's status becomes `unresponsive` after the last unanswered
   attempt.

## 3 · Demo trigger and stale-lead boot (US2, FR-017)

1. Open a lead's drawer that currently shows no pending attempt; confirm the
   action explains why (nothing pending) rather than erroring.
2. Open a lead mid-qualification with a pending attempt; click the drawer
   action; confirm the next sweep (within `WORKER_SWEEP_INTERVAL_MS`) sends it.
3. From a fresh `docker compose down -v && docker compose up`, confirm the
   seeded stale lead (spec 002's "frio parado há dois dias") receives its
   follow-up on the very first sweep after boot, unaided.

## 4 · Agenda scoping (US3)

1. Sign in as a broker with confirmed appointments; confirm only their own rows
   show.
2. Sign in as the sales manager; confirm every broker's appointments show.
3. Mark one appointment `done` and one `cancelled`; reload; confirm both
   persist and neither reappears as `confirmed`.
4. Clear all appointments for a broker (or view an empty day range); confirm
   the explanatory empty-state copy renders, not a blank list.

## 5 · Eligibility and window rules (SC-007)

1. With the system clock past `FOLLOWUP_WINDOW_END`, force a job's
   `scheduledFor` into the past (`UPDATE followup_jobs SET "scheduledFor" =
   now() - interval '1 minute'`) and wait for a sweep; confirm the row is
   rescheduled to the next window opening, `pending`, attempt number unchanged
   — not sent, not cancelled.
2. Set a lead's `doNotContact` to true with a due attempt pending; wait for a
   sweep; confirm the row is `cancelled` and nothing was sent.
3. Set the conversation `status` to `paused` (broker took over) with a due
   attempt pending; confirm the same outcome.

## 6 · Concurrency (SC-005)

Run `tests/followup-claim.test.ts` (`INTEGRATION=1 npm test -- followup-claim`)
against the container's Postgres: it seeds 100 due rows, launches two claimers
concurrently, and asserts exactly 100 processed, zero duplicated, zero lost.

## 7 · Unit and environment gates

```
npm test                              # scheduling.test.ts (SC-002, 200 cases), rotation.test.ts
npm test -- env-example               # FOLLOWUP_FIRST_DELAY_MINUTES in, FOLLOWUP_FIRST_DELAY_HOURS gone
INTEGRATION=1 npm test -- followup-writer   # SC-006, against local oMLX
```
