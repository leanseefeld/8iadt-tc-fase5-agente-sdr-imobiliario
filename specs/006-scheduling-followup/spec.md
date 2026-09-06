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
   is assigned by rotation and the options come from that broker's calendar, skipping any preferred hour already
   taken by a confirmed appointment, and none falls within the next 24 hours, on a weekend, or outside
   09:00–18:00 in the agency timezone.
2. **Given** three options were offered, **When** the lead picks the second, **Then** an appointment is confirmed
   at that time, the lead's status becomes *scheduled*, and the confirmation names weekday, date, time, type and
   — for a viewing — the property code, shown as a compact card.
3. **Given** the lead answers with a time of their own, **When** it satisfies the same rules, **Then** it is
   booked; **when** it does not, the agent says why and offers options again.

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
   recovery is recorded, and the lead is no longer *unresponsive*.
5. **Given** the maximum attempts were sent unanswered, **Then** the lead becomes *unresponsive*; **given** an
   opted-out lead or a conversation a broker took over, a due attempt sends nothing and is cancelled.
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
   reload; **given** nothing to list, explanatory copy shows.

### Edge Cases

- **No free hour in the horizon**, or **an agency with no brokers**: the agent does not invent a calendar — it
  asks the lead for a time and raises a handoff. **Two leads booking the same hour at once**: the second fails
  the collision check rather than double-booking a broker.
- **The lead replies while a follow-up is being composed**: a claimed attempt must not send into a conversation
  that just woke up. **Repeated turns** never queue duplicate attempts. **Window arithmetic** is evaluated in the
  agency timezone, never UTC. **Model unreachable** fails the attempt without consuming it; **a summary not yet
  generated** leaves the message composed from slot state rather than contextless; **the widget closed on
  arrival** loses nothing, the message being stored.

## Requirements *(mandatory)*

### Functional Requirements

**Proposing and booking**

- **FR-001**: The system MUST offer up to three concrete options — date, time, type — when proposing a meeting,
  and MUST NOT ask the lead to name a time as its first move. With fewer than three available it MUST offer those
  it has; with none it MUST NOT propose, and MUST raise a handoff.
- **FR-002**: Options MUST be computed deterministically from the assigned broker's confirmed appointments:
  business days only, inside 09:00–18:00 in the agency timezone, preferring 10:00, 14:00 and 16:30 in that order,
  no collision with a confirmed appointment, never sooner than 24 hours from now. The computation MUST be a pure
  function of busy intervals, the instant and the rules — testable with no database.
- **FR-003**: A lead with no assigned broker MUST be assigned one at the first proposal by rotation across the
  agency's brokers — even and repeatable, not random.
- **FR-004**: Proposing MUST record a proposed appointment and emit `appointment.proposed`; a further proposal
  for the same conversation MUST replace the previous one rather than accumulate. Proposed appointments MUST NOT
  block availability; confirmed ones do.
- **FR-005**: Booking MUST accept the index of an offered option or an explicit date and time, MUST validate both
  against FR-002 before confirming, and on failure MUST return the reason to the agent so it can explain and
  re-propose, creating no appointment.
- **FR-006**: Booking MUST confirm the appointment, emit `appointment.confirmed`, set the lead's status to
  *scheduled*, and produce a confirmation naming weekday, date, time, meeting type and — for a viewing — the
  property code, rendered in the widget as a compact card.

**Agenda**

- **FR-007**: The agenda MUST group appointments by day — *Hoje*, *Amanhã*, then weekday and date — each group
  ordered by time, MUST NOT list merely proposed ones, and MUST show explanatory copy when empty. Each row MUST
  show time, lead name, meeting type, property code with neighborhood where there is a property, and status.
- **FR-008**: A broker MUST see only their own appointments and a sales manager every appointment of the agency;
  every query MUST be scoped by agency. A signed-in user MUST be able to mark an appointment done or cancelled,
  persisted.

**Scheduling a follow-up**

- **FR-009**: When a turn leaves the conversation waiting on the lead — a pending qualification question, or
  options awaiting a choice — the system MUST ensure exactly one pending attempt exists for that conversation,
  due at the configured first delay, and MUST emit `followup.scheduled`. Enqueueing MUST be an upsert keyed by
  conversation: repeated turns move that attempt's due time, never create a second. Nothing MUST be enqueued when
  the conversation is paused or closed, when the lead has opted out, or when nothing is pending.
- **FR-010**: An inbound lead message MUST cancel every pending attempt for that conversation; if a follow-up had
  already been sent it MUST emit `followup.recovered` and move the lead out of *unresponsive* to the status its
  qualification state implies.

**Sending a follow-up**

- **FR-011**: The worker MUST claim due attempts so two concurrent sweeps never process the same attempt, using
  row-level locking that skips already-claimed rows, and MUST run as a registered consumer of the worker's
  existing sweep loop rather than as its own timer, reporting what it did in the structured log.
- **FR-012**: Eligibility MUST be re-checked at send time, not only at claim time: conversation active and
  unpaused, lead not opted out, attempt within the configured maximum, current instant inside the window in the
  configured timezone.
- **FR-013**: An attempt due outside the window MUST be rescheduled to the next opening of that window — never
  skipped, never consumed. One failing eligibility otherwise MUST be cancelled without sending. A failed send —
  model unreachable, channel error — MUST leave the attempt retryable, no attempt count consumed, no partial
  message reaching the lead.
- **FR-014**: The message MUST be generated from the stored summary and slot state — never the full transcript —
  MUST reopen with explicit context naming a concrete detail of what the lead is looking for, and MUST end with
  the pending question.
- **FR-015**: It MUST be delivered through the same channel abstraction as any other agent message, stored as an
  agent message marked as a follow-up, and visible in the widget whether it is open at the time or reopened later.
- **FR-016**: A successful send MUST emit `followup.sent`, increment the conversation's attempt count, and
  schedule the next attempt at three times the previous interval until the maximum is reached; after the final
  unanswered attempt the lead MUST become *unresponsive*.

**Demonstration and configuration**

- **FR-017**: The lead drawer MUST offer an action making the lead's pending attempt due immediately, unavailable
  with an explanation when there is none. The seeded stale lead MUST carry an attempt already due, so the first
  sweep after a fresh start sends a follow-up unaided.
- **FR-018**: The first delay MUST be configured in minutes, replacing the hours key; window bounds, timezone and
  maximum attempts remain configuration. Schema, example file and its test MUST stay in step in the same change,
  and the demonstration values — short first delay, short sweep interval — MUST be documented apart from the
  production-shaped defaults.

### Key Entities

- **Appointment** — a meeting between a lead and a broker, optionally about a property, with an instant, a type
  (*viewing* · *call*) and a state moving *proposed* → *confirmed* → *done* or *cancelled*.
- **Follow-up attempt** — one scheduled reengagement for a conversation, with its attempt number, due time and
  state; at most one pending per conversation. **Broker assignment** — the lead's owning broker, set at the first
  proposal. No new tables: each is defined by
  [`modelo-de-dados.md`](../../docs/arquitetura/modelo-de-dados.md) and materialised by spec 002.

## Success Criteria *(mandatory)*

- **SC-001**: In ten consecutive qualification runs the agent proposes dated options and never asks the lead to
  name a time first — 10 of 10.
- **SC-002**: Across at least 200 generated busy-calendar cases, zero proposed options collide with a confirmed
  appointment, fall on a weekend, fall outside 09:00–18:00, or fall inside the next 24 hours.
- **SC-003**: From the lead accepting an option, the confirmation appears in the widget in under 3 seconds and
  the appointment is on the agenda on the next load, which holds zero appointments of another broker.
- **SC-004**: Over 30 first proposals, assignment counts differ by at most one lead between any two brokers.
- **SC-005**: Two concurrent claimers over 100 due attempts process each exactly once — 100 processed, zero
  duplicated, zero lost.
- **SC-006**: A follow-up generated from a seeded summary mentions the neighborhood and the price ceiling from
  that summary and ends with a question, against the local model.
- **SC-007**: Zero follow-ups are sent outside the window, to an opted-out lead, or into a paused conversation,
  across the full suite; one coming due outside the window is sent at the next opening, attempt number unchanged.
- **SC-008**: A lead replying after a follow-up is counted as recovered exactly once, leaving *unresponsive* in
  the same turn.
- **SC-009**: With demonstration values configured, the drawer action produces a follow-up in the widget in under
  30 seconds; a fresh start produces one to the seeded stale lead within one sweep of boot.
- **SC-010**: The environment contract test passes with the new key present and the replaced key gone — nothing
  read but undocumented, nothing documented but unread.

## Clarifications

Resolved by the author against `docs/` before planning; `docs/decisoes-pendentes.md` has nothing open here.

- **Q**: `appointment.proposed` carries one `appointmentId`, but three options are shown — what does that id
  point at? → **A**: One row per proposal, created *proposed* at the first option's time, the options carried in
  the message metadata; booking moves that same row to *confirmed*, so both events name one id.
- **Q**: What if the broker has no free preferred hour? → **A**: Search forward ten business days; offer fewer
  than three if that is all there is; with zero, do not propose — ask the lead for a time and raise a handoff.
- **Q**: Viewings run 09:00–18:00 while the follow-up window is 09:00–20:00 and configurable — which timezone
  governs viewings? → **A**: `FOLLOWUP_TIMEZONE`, read as the agency's operating timezone rather than churning
  the environment contract for one agency. Viewing hours are domain constants: ADR 15 made only the follow-up
  window configurable.
- **Q**: A recovered lead leaves *unresponsive* — for which status? → **A**: The one its state implies,
  recomputed: *scheduled* with a confirmed appointment, *qualified* when every script slot is filled, otherwise
  *qualifying*. No new status, no memory of the previous one.
- **Q**: How is "the reply ends with a question" decided? → **A**: By the slot machine's state — a pending
  question or an unanswered proposal — not by inspecting message text. Punctuation is not a state machine, and
  principle V puts the decision in code.

## Assumptions

- **Spec 004 owns the turn.** This slice implements the two tools its registry declares, the enqueue at the end
  of a turn and the cancellation on an inbound message; it does not change how a turn is orchestrated. **Spec 005
  owns the worker's consumer registry and the lead drawer**: this slice registers a consumer through
  `register(consumer: { name, run(db, now) })` and adds one action to the drawer's actions row.
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
  widget. Per-broker working hours, capacity limits, holiday calendars, and reassigning a lead between brokers —
  the last belongs to spec 005's manager view.
