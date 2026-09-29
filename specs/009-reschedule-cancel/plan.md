# Spec 009 — plan and record

Built on 29/09/2026 against the one-page [spec](spec.md). This plan adds no requirement of its own. Where it chose
something the page doesn't say, that choice is listed under *Decisions I made*.

## What changed

- **Service** (`src/services/scheduling.ts`): `listUpcomingMeetings`, `cancelAppointment` (scoped to the lead),
  `computeRescheduleOptions` and `rescheduleAppointment`.
  - A reschedule is `confirmed → confirmed` on the same row, through `transitionAppointment`.
  - It's judged by the same `checkSlot`, under the same per-broker lock, with the meeting's own slot left out of
    the busy intervals.
  - `MAX_UPCOMING_MEETINGS = 3`.
- **Turn** (`src/agent/orchestrator.ts` `decideChange`, `src/agent/meeting-change.ts`).
  - Extraction facts `changeRequest` (cancel / reschedule) and `answer` (yes / no) replace 006's
    `wantsToChangeBooking`.
  - What's pending between turns lives on the agent message's metadata (`pendingCancel`, `pendingChoice`,
    `reschedulingId`, `rebook`), like 006's options.
  - Cancel is decided in code after the lead's yes. It's not a model tool, because the decision is the lead's.
  - Reschedule goes to the action loop with the new tool `rescheduleMeeting`. When it isn't called, the lead
    gets times for that meeting.
- **Sentences** (`src/agent/prompts/meeting.ts`): all code-written, and no broker names.

## Decisions I made (not on the page)

- **"Qual delas?" is answered by matching the lead's reply against the meetings just listed** (code, weekday,
  phone, date). That's a closed set, so it's reading a choice, not guessing. It was needed because the model
  didn't read "a de terça" as a weekday.
- **No automatic offer to a lead who already has a meeting.** Before, an offer could fire mid-conversation for
  a lead whose meetings were booked outside the chat.
- **The booking briefing lists the next seven days with their dates.** The model had read "segunda" as the
  Monday that had already passed.
- **Cancelling offers to rebook** (the page says so); a yes to that offers times for the same property, or the
  phone.

## Tests

- Unit: `tests/meeting-change.test.ts` (which meeting, the answer to "qual delas?", the sentences), plus
  `tests/act.test.ts` for the tool.
- Service, `INTEGRATION=1`: `tests/scheduling-service.test.ts`, three 009 cases (moves the same row, judged like
  a booking, cancel scoped to the lead).
- Model, `INTEGRATION=1` on 12B: `tests/integration/changes.test.ts`, the page's seven examples. 7 of 7, twice
  in a row after the fixes above.
- 006's FR-004g test now expects 009's behaviour: *"Quer mesmo cancelar…?"*, and nothing changes before a yes.
