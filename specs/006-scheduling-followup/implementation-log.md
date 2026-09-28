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

On `006-scheduling-followup` before any code change: container suite **229 pass, 0 fail, 4 skipped**;
`npx tsc --noEmit` clean; `npm run lint` clean.

## Phase 1 (T001–T003)

- **T002** — five keys in `core/config.ts` and `.env.example`, one commit (`ec4b764`).
  `SCHEDULING_PREFERRED_TIMES` is a comma list whose written order is the preference; a config test pins it.
  The developer's own gitignored `.env` still carries the obsolete `FOLLOWUP_FIRST_DELAY_HOURS=4`; harmless
  (the schema ignores unknown keys), left for them to remove.
- **T003** — `agencies.followupEnabled` (default on) and both partial indexes, **in the Drizzle model**, with the
  migration generated from it (`0003_scheduling_followup.sql`) — unlike 005's hand-written index migration,
  because a new column has to live in the model's snapshot or the next `db:generate` re-adds it. **Recorded
  overlap:** `followup_jobs` already had spec 002's full index on `(status, scheduled_for)`; the new partial
  `followup_jobs_claim_idx` makes it largely redundant. Not dropped — that index is 002's.

## Phase 2 (T004–T010) — done; stopped here as agreed, before US1

- **Domain** (`src/domain/scheduling.ts`): one rule, `checkSlot`, behind both offering and booking. The lead's
  preference is applied **before** the cap of three (applied after, "quinta" found nothing when Mon/Tue filled
  the three) — `filterByPreference` stays as a pure helper, but `proposeSlots` takes the preference itself.
- **SC-002:** 200 seeded calendars (127 → three options, 32 → one or two, 41 → none; 101 with a preference, 189
  with busy slots) equal a brute-force oracle written with plain UTC−3 arithmetic, independent of the module's
  Intl code. Mutation-checked: dropping the notice rule, letting a meeting overrun the broker's hours, or
  ignoring collisions each fails it.
- **Service** (`src/services/scheduling.ts`): `transitionAppointment` is the only writer of status;
  `computeOptions` reads only and returns a broker **id**, never a name; `recordProposal` is cancel-then-insert
  and writes the lead's assignment; booking takes a per-broker advisory lock so the second of two racing leads
  gets `collision`. `bookAppointment` takes the `offered` times from the caller (the message that presented
  them) — 1-based `optionIndex`, as the lead reads the list.
- **Tests:** `tests/scheduling-service.test.ts` (INTEGRATION=1, throwaway agency, fixed 2030 Monday): 10/10.
  Container suite **239 pass, 0 fail, 5 skipped** (the new DB test is the fifth skip without INTEGRATION=1).
  Typecheck and lint clean.
- **Contract drift noted, not fixed:** `contracts/interfaces.md` §2 still lists `saveBrokerAvailability`
  (cut to backlog 34), and §1's `SlotRules` gained a `type` field so options carry their meeting type.

**Next:** Phase 3 (US1), starting at T011 — needs the developer's go. *(Given 2026-09-28.)*

## Phase 3 (T011–T022c) — US1: propose in code, book by tool, three ways out

**As built.**
- `prompts/meeting.ts` writes every scheduling sentence (options, confirmation, no options, a refused booking's
  reason, the decline acknowledgement, "assim que eu tiver seus dados…"). None names a broker.
- The extraction gains flat fields: `declinedOffer`, `askedForTimes`, `pickedTime`, `preferredWeekday`,
  `preferredPeriod`, `propertyPosition` and `propertyCode`. They're flat rather than the nested
  `timePreference`/`propertyRef` of the contract, because the 4-bit extraction is steadier without nesting.
- `run()` decides the meeting in code, then offers `act()` for search and/or booking.
- A written scheduling reply wins the turn. The decline and "details first" are prefixes to the phrased reply.
- `bookMeeting` is the only new tool. `scheduling.stub.ts` is deleted.
- The widget gains `MeetingCard` (from `booking` metadata, lifted by `wire.ts` without the appointment id) and
  the **Interessado** button. The button is revealed on hover/focus on pointer devices, always visible on touch,
  44 px tall, and wraps under the card's details on a phone.

**The first live replays (4 conversations through `POST /api/chat`) found five bugs. All are fixed, and each fix
is pinned by a test:**
1. *Every pick handed off.* The extraction set `askedForHuman` on "a segunda", "quero agendar" and
   "quem vai me atender?", because the meeting is with a person. Two fixes: the field's description now names
   these, and a code rule ignores `askedForHuman` on a message that picks, asks for or declines a meeting.
2. *A pick also read as a request for times* (both facts true). This re-offered instead of booking.
   A pick now outranks a request on the same message.
3. *The model called `bookMeeting` correctly and nothing booked.* It sent `{"optionIndex": "1"}`, a string,
   and the schema wanted a number. The tool now reads numeric strings, and "10h"/"10h30"/"9:30"
   (`tests/book-meeting.test.ts`).
4. *`commitTurn` undid the booking's stage.* It recomputed the stage from the lead as loaded at the start of
   the turn (`qualified`) and wrote it back over `scheduled`. It now reads the stage again when the turn
   booked.
5. *"Details first" repeated on every answer, and was said for a bare interest.* It's now said once, and only
   when times were asked for (FR-004d: an interest before the script is complete just continues the script).
6. *(Not a bug, a UX flag)* A "no" with nothing open to decline counted as a misunderstanding
   ("Desculpa, eu não entendi"). It now counts as understood, with nothing to act on.

**e4b and the tool (T019, spec 007 FR-030).** e4b drove `bookMeeting` **unaided** in every case: option index,
a named time outside the week (read as `too_soon`/`unavailable`), a collision, and the interest flow. The only
failure was the string index above, which was a contract fix, not a model limit. No 12B escalation.

**Tests.**
- Unit: `precedence` (every `replyKind` pair, the decline prefix, exact sentences, strict fact reading),
  `briefing-boundary` (attendance neither confirmed nor denied), `property-ref`, `book-meeting`.
- `INTEGRATION=1` on e4b: `booking.test.ts` 4/4 and `meeting-escapes.test.ts`, both green.
- `offer-once.test.ts` was updated for two reasons. First, its cleanup must now delete the proposal row.
  Second, with no property in play the offer is a **call** (contract §2), where it was a viewing before 006.

**Flag for the developer.** A purchase lead who finishes the script without pointing at a card is offered
*"uma conversa com alguém da nossa equipe"*. That still happens even if they typed "quero marcar uma visita",
because a viewing needs a property and none was named. This is the contract as written (§2). The **Interessado**
button, or "gostei do primeiro", is the path to a visit. Worth a sentence in the options if the demo shows it.

**Docs.**
- `docs/arquitetura/turno-do-agente.md` is updated in this commit (AGENTS rule): the meeting path is no longer
  *planejado*, and there is a new written-reply branch plus the handoff exception. Both Mermaid diagrams parse.
- `contracts/interfaces.md` drift is fixed: `saveBrokerAvailability` cut; `SlotRules.type` and `Preference`
  added; the `bookAppointment` and `bookMeeting` shapes are as built; the extraction fields are flat.

**Full `INTEGRATION=1` run (381 tests) after Phase 3.** Everything 006 touches is green. The failures that
remained are not 006's:
- `revision.test.ts` has failed since 007's closing commit `4d59f7d`. That commit removed region matching from
  the chat search, so "zona norte" no longer finds Santana. It's a product question, whether the chat should
  match regions.
- `seed.test.ts` expects exactly 3 demo leads. The developer's own widget sessions add more.
- `leads-scope.test.ts` failed only because `auth-service.test.ts` reassigns the seeded lead and never
  restores it. Restored by hand; a clean-up task was suggested.

I deleted my own replay and test leads (27) from the demo agency; the developer's sessions were kept.

## Phase 4 (T023–T032) — US2: reopening a stalled conversation

**As built.**
- `services/followup.ts` has the three rules:
  - `scheduleFollowup`: an upsert keyed by conversation, with every FR-009 guard in the statement's own `where`.
  - `cancelFollowup`: resets the state and reads the old count in the same statement, so `followup.recovered`
    fires once.
  - `followupEligibility`: the agency switch, active and unheld, no opt-out, under the maximum, no confirmed
    future appointment, inside the window.
- Also in the service: `triggerNow` and `setFollowupEnabled` (salesManager only), plus `restartAfterHandback`
  (FR-009a).
- `commitTurn` schedules when the reply leaves the script's next question or options awaiting a pick.
  `recordLeadMessage` cancels on every stored lead message. `returnToAgent` restarts the clock when something
  is still open.
- `jobs/followup.ts` runs as a registered consumer:
  - it claims with `UPDATE … WHERE id IN (… FOR UPDATE SKIP LOCKED)` and reclaims rows stuck `running`
    for 10 minutes;
  - it checks eligibility twice, around the composition;
  - outside the window it moves the attempt, and any other failed check cancels it (FR-013a clears the
    *pending* state);
  - a failed compose or send puts the row back untouched.
- The sweep's clock is its `now` plus elapsed time, so tests pin the window.
- The writer (`agent/followup-writer.ts`) splits the message. **The model writes only the opening sentence.**
  It's checked: no question, no date/hour/weekday, no team name, no "[placeholder]". If it fails, a code-written
  opening replaces it. **Code appends the pending question verbatim**, which is "ends with the pending question"
  by construction, and a proposal is invited back without quoting a time (FR-014).
- Delivery goes through `ChannelAdapter.send` with `isFollowUp`, stored on the message metadata (FR-015).
  The event is `followup.sent`, with `actorType: worker` and the trace id of a `followup.send` trace
  (`withTurnTrace` gained an optional trace name).
- Dashboard: a switch in the leads header. The manager can press it; a broker sees its state in words.
  The drawer gets **Enviar follow-up agora**, disabled with its reason when nothing is pending or the switch
  is off.
- Seed: the stale demo lead gets its due attempt. The live DB's Julia got the same by hand, and the worker
  moved it to 09:00 local, so at 09:00 it sends her a real follow-up.

**Found on the way.**
- e4b's first opening read like the broker summary ("Entendi, Camila procura…"). The prompt now asks for
  second person, with an example on other data. Three runs in a row came out right.
- With no name known, the model wrote a literal "Oi, [Nome da pessoa]!". Brackets are now refused, and the name
  falls back to the `name` slot.

**Tests.**
- `followup-claim` (SC-005): 2 claimers over 100 rows; 100 sent, 0 twice, 0 lost, and both claimed.
- `followup-eligibility` (SC-007, SC-008, SC-014, FR-013a, FR-009): 7 cases.
- `followup-writer` unit: 4 cases.
- `INTEGRATION=1` `followup-writer` (SC-006) and `followup-send`: real e4b, real web channel, message marked
  as a follow-up.
- Verified in the browser as the seeded manager:
  - the switch turns off and on, with its feedback in words;
  - with it off, the drawer button is disabled and explains why;
  - with it on, pressing it queues the attempt, and the worker claimed it and moved it to the window.
- Every integration cleanup now deletes `followup_jobs` and `appointments` before the conversation.

**Not verified.** A `followup.sent` trace id from the **worker** process. The test process doesn't register
Langfuse. The first real send (Julia, 09:00) is where to read it.

**Incident, fixed before commit.** A full `INTEGRATION=1` run swept with a clock pinned to 2030 (to be inside
the window). That made *every* pending attempt in the database due, including the demo's real one for Julia.
A stub-writer test marked it `sent` and queued a 2030 retry. No message reached her, because the stub never
sends. Repaired by hand: attempt back to `pending` at 09:00, count 0, the stray row and event removed.
`sweepFollowups` now takes an optional scope (`agencyId` / `conversationIds`), and every test sweep uses it;
production claims everything as before. The query for `isFollowUp` messages and 2030 rows returns nothing.
