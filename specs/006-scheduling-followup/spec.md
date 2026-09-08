# Feature Specification: Scheduling and Follow-up

**Feature Branch**: `006-scheduling-followup` | **Created**: 2026-09-05 | **Status**: Draft

**Input**: Backlog spec 006 — *Scheduling and follow-up* (original items 10 + 11): concrete slot proposals and
booking, the agenda screen, and the worker follow-up sweep with its eligibility rules, attempt cap, growing
intervals and demo trigger. It closes **scenario 3 of the challenge statement** and is the only place where the
system acts without a lead having just spoken — where the *memória conversacional* claim becomes visible, the
reopening message being written from the stored summary days after the conversation stalled.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The agent offers real times, not a preference question (Priority: P1)

A qualified lead shows interest in a property or asks to talk to someone. Instead of "quando você prefere?", the
agent offers three concrete options from the assigned broker's real availability, and confirms the chosen one.

**Why this priority**: A meeting on a broker's calendar is what the qualification flow exists to produce, and
offering times requires knowing a calendar while asking does not.

**Independent Test**: Qualify a lead to the point of interest; the next agent message carries three dated options
that miss the broker's confirmed appointments. Choose one and find it on the agenda.

**Acceptance Scenarios**:

1. **Given** a qualified lead with no broker, **When** options are proposed for the first time, **Then** a broker
   is assigned by rotation among brokers whose `specializations` include the lead's intent — falling back to any
   broker — and the options come from that broker's own weekday availability, skipping a preferred hour already
   taken, and none falls sooner than `SCHEDULING_MIN_NOTICE_MINUTES` or on a day/hour the broker has not enabled.
2. **Given** three options were offered, **When** the lead picks the second, **Then** an appointment is confirmed
   at that time, the lead's pipeline stage becomes *scheduled* regardless of conversation state, and the
   confirmation names weekday, date, time, type and — for a viewing — the property code, as a compact card.
3. **Given** the lead answers with a time of their own, **When** it satisfies the same rules, **Then** it is
   booked; **when** it does not, the agent says why and offers options again.
4. **Given** the lead's intent is `investment`, **When** options are proposed, **Then** every option is a `call`
   with no property attached, from a broker whose `specializations` include `investment`.

### User Story 2 - The agent reopens a conversation that went quiet (Priority: P1)

A lead answers two questions and stops. After a configured delay the agent writes again — not "oi, tudo bem?" but
a message naming what the conversation was about ("sobre o apê de 2 quartos em Moema, até 700 mil…") and asking
the question left hanging. Three attempts at most, spaced further apart each time, never outside the allowed
hours, never after an opt-out. For a demonstration, an action in the lead drawer makes the pending attempt due at
once — same job, same sweep, same send path, nothing faked.

**Why this priority**: A graded scenario, the strongest moment in the demonstration, and the only requirement that
proves the worker is a real process rather than a diagram.

**Independent Test**: Answer two questions in the widget and stop. After the first delay the agent writes again
with context from the summary; reply, and nothing further is sent while the recovery is recorded.

**Acceptance Scenarios**:

1. **Given** an agent reply that left the conversation waiting on the lead, **Then** exactly one pending attempt
   exists for it, due at the first delay from now.
2. **Given** a pending attempt whose time has come, **When** the worker sweeps, **Then** the lead receives one
   message mentioning a concrete detail from the stored summary and ending with the pending question — and with
   two worker replicas sweeping it, exactly one message is sent.
3. **Given** an attempt due at 03:00, **When** the worker sweeps then, **Then** nothing is sent and it moves to
   the next window opening — not skipped, not consumed.
4. **Given** a follow-up was sent, **When** the lead replies, **Then** pending attempts are cancelled, the
   recovery is recorded, `followupAttempts` resets to zero, and `conversations.followupState` returns to `none`.
5. **Given** the maximum attempts were sent unanswered, **Then** `conversations.followupState` becomes
   `exhausted` (*Sem resposta*); **given** an opted-out lead, a broker-held conversation, or a confirmed future
   appointment, a due attempt sends nothing and is cancelled.
6. **Given** the drawer action is used, **Then** the attempt is due immediately and goes out on the next sweep
   under the usual eligibility rules; **given** a freshly seeded database, the stale demonstration lead's attempt
   is already due on the first sweep after boot.

### User Story 3 - A broker sees the day's meetings (Priority: P2)

A broker opens *Agenda* and reads what is booked: today, tomorrow, then the days after — time, who with, viewing
or call, which property, and the state of the meeting.

**Why this priority**: Scheduling that produces nothing a broker can look at is scheduling the demonstration
cannot show. P2 because the appointment is correct without this screen.

**Independent Test**: Open the agenda as a broker and as a manager; check grouping, rows and scoping, then mark
one appointment done and one cancelled.

**Acceptance Scenarios**:

1. **Given** appointments across several days, **Then** they are grouped by day — *Hoje*, *Amanhã*, then weekday
   and date — each group ascending by time, and a broker sees only their own while a manager sees the agency's.
2. **Given** an appointment in the list, **When** it is marked done or cancelled, **Then** the change survives a
   reload, *done* also moves the lead's pipeline stage to *visited*, and both emit their event
   (`appointment.done`/`appointment.cancelled`) with `actorType: user` and `actorUserId`; **given** nothing to
   list, explanatory copy shows.
3. **Given** a broker opens "Minha disponibilidade", **When** they toggle a weekday, change a start or end time,
   and save, **Then** it persists to their `users.availability` via Server Action, reflected in their next
   proposal.

### Edge Cases

- **No free hour in the horizon**, **a broker with every weekday disabled**, or **an agency with no brokers**: the
  agent does not invent a calendar — it asks the lead for a time and raises a handoff. **Two leads booking the
  same hour at once**: the second fails the collision check. **An `investment` lead with no specialist broker**:
  assignment falls back to rotation across every broker.
- **The lead replies while a follow-up is being composed**: a claimed attempt must not send into a conversation
  that just woke up. **Repeated turns** never queue duplicate attempts. **Window arithmetic** is evaluated in the
  agency timezone, never UTC. **Model unreachable** fails the attempt without consuming it; **a summary not yet
  generated** falls back to slot state; **the widget closed on arrival** loses nothing, the message being stored.
  **A confirmed future appointment** blocks a pending attempt (FR-009); a **handed-back conversation** restarts
  the clock, an **appointment closure** never does (FR-009a).

## Requirements *(mandatory)*

### Functional Requirements

**Proposing and booking**

- **FR-001**: The system MUST offer up to three concrete options — date, time, type — when proposing a meeting,
  and MUST NOT ask the lead to name a time as its first move. With fewer than three available it MUST offer those
  it has; with none it MUST NOT propose, and MUST raise a handoff.
- **FR-002**: Options MUST be computed deterministically from the assigned broker's own weekday availability
  (`users.availability`, per weekday `{ enabled, start, end }`) and confirmed appointments: only enabled weekdays
  and hours inside that broker's own window, preferring the order in `SCHEDULING_PREFERRED_TIMES`, no collision
  with a confirmed appointment, never sooner than `SCHEDULING_MIN_NOTICE_MINUTES` from now. The computation MUST
  be a pure function of the broker's availability, busy intervals, the instant, and the configured notice and
  preferred times — testable with no database. Booking MUST validate the chosen option against it again, so the
  lead never sees an option that later fails.
- **FR-003**: A lead with no assigned broker MUST be assigned one at the first proposal by rotation among the
  agency's brokers whose `specializations` include the lead's `intent`, falling back to rotation across every
  broker when none matches — even and repeatable, not random.
- **FR-003a**: When the lead's `intent` is `investment`, every option MUST be `call`, carry no `propertyId`, and
  come from FR-003's rotation restricted to `investment` specialists.
- **FR-004**: Proposing MUST record a proposed appointment and emit `appointment.proposed`; a further proposal
  for the same conversation MUST replace the previous one rather than accumulate. Proposed appointments MUST NOT
  block availability; confirmed ones do.
- **FR-005**: Booking MUST accept the index of an offered option or an explicit date and time, MUST validate both
  against FR-002 before confirming, and on failure MUST return the reason to the agent so it can explain and
  re-propose, creating no appointment.
- **FR-006**: Booking MUST confirm the appointment, emit `appointment.confirmed`, and set the lead's pipeline
  stage to *scheduled* regardless of conversation state — a `paused` conversation may still hold a booking made
  earlier — producing a confirmation naming weekday, date, time, type and — for a viewing — the property code,
  rendered in the widget as a compact card.

**Agenda**

- **FR-007**: The agenda MUST group appointments by day — *Hoje*, *Amanhã*, then weekday and date — each group
  ordered by time, MUST NOT list merely proposed ones, and MUST show explanatory copy when empty. Each row MUST
  show time, lead name, meeting type, property code with neighborhood where there is a property, and status.
- **FR-008**: A broker MUST see only their own appointments and a sales manager every appointment of the agency;
  every query MUST be scoped by agency. A signed-in user MUST be able to mark an appointment *done* or
  *cancelled*, persisted; marking *done* also sets the lead's pipeline stage to *visited*, and both emit their
  event (`appointment.done` / `appointment.cancelled`) with `actorType: user` and the acting `actorUserId`.
- **FR-008a**: The agenda MUST offer a "Minha disponibilidade" editor — seven rows, one per weekday, each with an
  enabled toggle, a start and an end time — saved via Server Action to that broker's `users.availability`,
  immediately reflected in their next computed options.

**Scheduling a follow-up**

- **FR-009**: When a turn leaves the conversation waiting on the lead — a pending question, or options awaiting a
  choice, per the slot machine's own state — the system MUST ensure exactly one pending attempt exists, set
  `conversations.followupState = pending`, due at the configured first delay, and emit `followup.scheduled`.
  Enqueueing MUST be an upsert keyed by conversation: repeated turns move the due time, never create a second.
  Nothing MUST be enqueued when the conversation is paused or closed, the lead opted out, the lead has a confirmed
  future appointment, `followupAttempts` is at the configured maximum, or nothing is pending.
- **FR-009a**: A conversation returned to the agent (`heldByUserId` cleared) with something still open MUST
  restart the follow-up clock, per FR-009; an appointment reaching *done* or *cancelled* MUST NOT itself schedule
  or restart automatic follow-up — further reengagement is the broker's call, from the agenda.
- **FR-010**: An inbound lead message MUST cancel every pending attempt and reset `followupAttempts` to zero and
  `conversations.followupState` to `none`; if a follow-up had already been sent it MUST also emit
  `followup.recovered` and move the lead out of `exhausted` (*Sem resposta*) to the stage its state implies.

**Sending a follow-up**

- **FR-011**: The worker MUST claim due attempts so two concurrent sweeps never process the same attempt, using
  row-level locking that skips already-claimed rows, and MUST run as a registered consumer of the worker's
  existing sweep loop rather than as its own timer, reporting what it did in the structured log.
- **FR-012**: Eligibility MUST be re-checked at send time, not only at claim time: conversation active and
  unpaused, lead not opted out, lead with no confirmed future appointment, attempt within the configured maximum,
  current instant inside the window in the configured timezone. It is checked at claim because the wait for the
  sweep is enough for eligibility to change; it is checked again right before send because composing the message
  itself takes long enough for the lead to reply mid-composition.
- **FR-013**: An attempt due outside the window MUST be rescheduled to the next opening — never skipped, never
  consumed. One failing eligibility otherwise MUST be cancelled without sending. A failed send — model
  unreachable, channel error — MUST leave the attempt retryable, no count consumed, no partial message reaching
  the lead.
- **FR-014**: The message MUST be generated from the stored summary and slot state — never the full transcript —
  MUST reopen with explicit context naming a concrete detail of what the lead is looking for, and MUST end with
  the pending question.
- **FR-015**: It MUST be delivered through the same channel abstraction as any other agent message and through
  the Notifier/SSE path — never a polling read — stored as an agent message marked as a follow-up, visible in the
  widget whether open at the time or reopened later.
- **FR-016**: A successful send MUST emit `followup.sent` with `actorType: worker` and the composing call's
  Langfuse `traceId` (trace name `followup.send`, session id = the conversation id), increment the attempt count,
  and schedule the next attempt at `FOLLOWUP_BACKOFF_FACTOR` times the previous interval until the maximum is
  reached; after the final unanswered attempt `conversations.followupState` becomes `exhausted` — *Sem resposta*.

**Demonstration and configuration**

- **FR-017**: The lead drawer MUST offer an action making the lead's pending attempt due immediately, unavailable
  with an explanation when there is none. The seeded stale lead MUST carry an attempt already due, so the first
  sweep after a fresh start sends a follow-up unaided.
- **FR-018**: The first delay MUST be configured in minutes, replacing the hours key; `SCHEDULING_MIN_NOTICE_MINUTES`
  replaces the fixed 24-hour rule, `SCHEDULING_PREFERRED_TIMES` replaces the fixed preferred-hour list, and
  `FOLLOWUP_BACKOFF_FACTOR` replaces the hard-coded ×3. Schema, example file and its test MUST stay in step in the
  same change, and the demonstration values — `FOLLOWUP_FIRST_DELAY_MINUTES=5`, `WORKER_SWEEP_INTERVAL_MS=15000`
  — MUST be documented apart from the production-shaped defaults.

### Key Entities

- **Appointment** — a meeting between a lead and a broker, optionally about a property, with an instant, a type
  (*viewing* · *call*) and a state moving *proposed* → *confirmed* → *done* or *cancelled*.
- **Follow-up attempt** — one scheduled reengagement, with its attempt number, due time and state; at most one
  pending per conversation, mirrored by `conversations.followupState` (`none | pending | exhausted`). **Broker
  assignment** — set at the first proposal by specialization-filtered rotation, falling back to any broker.
  **Broker availability** — per-weekday `{ enabled, start, end }` on `users.availability`, seeded Mon–Fri
  09:00–18:00, editable on the agenda. No new tables: each is defined by
  [`modelo-de-dados.md`](../../docs/arquitetura/modelo-de-dados.md), materialised by spec 002.

## Success Criteria *(mandatory)*

- **SC-001**: In ten consecutive qualification runs the agent proposes dated options and never asks the lead to
  name a time first — 10 of 10.
- **SC-002**: Across at least 200 generated cases of broker availability and busy calendars, zero proposed
  options collide with a confirmed appointment, fall on a day or hour the broker has not enabled, or fall sooner
  than `SCHEDULING_MIN_NOTICE_MINUTES` from now.
- **SC-003**: From the lead accepting an option, the confirmation appears in the widget in under 3 seconds and
  the appointment is on the agenda on the next load, which holds zero appointments of another broker.
- **SC-004**: Over 30 first proposals to leads sharing one intent, assignment counts differ by at most one lead
  between any two brokers whose specializations include it.
- **SC-005**: Two concurrent claimers over 100 due attempts process each exactly once — 100 processed, zero
  duplicated, zero lost.
- **SC-006**: A follow-up generated from a seeded summary mentions the neighborhood and the price ceiling from
  that summary and ends with a question, against the local model.
- **SC-007**: Zero follow-ups are sent outside the window, to an opted-out lead, into a paused conversation, or to
  a lead with a confirmed future appointment; one coming due outside the window is sent at the next opening,
  attempt number unchanged.
- **SC-008**: A lead replying after a follow-up is counted as recovered exactly once, leaving `followupState`
  `none` and `followupAttempts` zero — clear of *Sem resposta* — in the same turn.
- **SC-009**: With demonstration values configured, the drawer action produces a follow-up in the widget in under
  30 seconds; a fresh start produces one to the seeded stale lead within one sweep of boot.
- **SC-010**: The environment contract test passes with every new key present and the replaced key gone —
  nothing read but undocumented, nothing documented but unread.
- **SC-011**: Saving the availability editor persists all seven rows, reflected in that broker's very next
  proposal.
- **SC-012**: Every proposal for an `investment` lead is a `call` with no property, from a specialist broker.

## Clarifications

Resolved by the author against `docs/` before planning; `docs/decisoes-pendentes.md` has nothing open here.

- **Q**: `appointment.proposed` carries one `appointmentId`, but three options are shown — what does that id
  point at? → **A**: One row per proposal, created *proposed* at the first option's time, the options carried in
  the message metadata; booking moves that same row to *confirmed*, so both events name one id.
- **Q**: What if the broker has no free preferred hour? → **A**: Search forward ten business days; offer fewer
  than three if that is all there is; with zero, do not propose — ask the lead for a time and raise a handoff.
- **Q**: Viewings run inside each broker's own availability while the follow-up window is 09:00–20:00 and
  configurable — which timezone governs viewings? → **A**: `FOLLOWUP_TIMEZONE`, applied to every broker's
  availability alike, one per agency. `SCHEDULING_MIN_NOTICE_MINUTES`/`SCHEDULING_PREFERRED_TIMES` are now
  agency config, superseding the earlier "domain constants" answer; a broker's hours are `users.availability`.
- **Q**: A recovered lead leaves the `exhausted` follow-up state — for which pipeline stage? → **A**: The stage
  its qualification state implies, recomputed: *scheduled* with a confirmed appointment, *qualified* when every
  slot is filled, otherwise *qualifying*. `followupState` returns to `none`, `followupAttempts` to zero.
- **Q**: How is "the reply ends with a question" decided? → **A**: By the slot machine's state — a pending
  question or an unanswered proposal — not by inspecting message text. Punctuation is not a state machine, and
  principle V puts the decision in code.

## Assumptions

- **Spec 004 owns the turn.** This slice implements the two tools its registry declares, the enqueue at the end
  of a turn and the cancellation on an inbound message; it does not change how a turn is orchestrated. **Spec 005
  owns the worker's consumer registry and the lead drawer**: this slice registers a consumer through
  `register(consumer: { name, run(ctx) })` and adds one action to the drawer's actions row.
- **Spec 002 owns the seed**, to which this slice adds the due pending attempt for the stale demonstration lead;
  **spec 003 owns the shell**, whose `/agenda` placeholder this replaces. The summary spec 005 generates
  asynchronously usually exists; a follow-up composed before it lands falls back to slot state.
- **Business days are Monday to Friday**, with no holiday calendar — a POC with one seeded agency has no source
  of truth for holidays. **Integration tests run inside the container** against the project's Postgres; the one
  model-dependent test uses the local oMLX model, tagged so the default suite skips it.

## Out of Scope

- Any calendar visualisation: the agenda is a list, deliberately. Rescheduling or cancelling from the widget — a
  broker changes status from the agenda instead.
- External calendar integration, invitation e-mail, reminder notification; follow-up on any channel but the web
  widget. Broker capacity limits, holiday calendars, and reassigning a lead between brokers — that last one
  belongs to spec 005's manager view. Per-broker working hours are now in scope, via `users.availability`.
