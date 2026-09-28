# Feature Specification: Scheduling and Follow-up

**Feature Branch**: `006-scheduling-followup` | **Created**: 2026-09-05 | **Status**: Draft

**Input**: Backlog spec 006 — *Scheduling and follow-up* (original items 10 + 11): concrete slot proposals and
booking, the agenda screen, and the worker follow-up sweep with its eligibility rules, attempt cap, growing
intervals and demo trigger. It closes **scenario 3 of the challenge statement** and is the only place where the
system acts without a lead having just spoken — where the *memória conversacional* claim becomes visible, the
reopening message being written from the stored summary days after the conversation stalled.

> **Amended 2026-09-28**, after [spec 007](../007-revisable-orchestration/spec.md) merged. Written 05/09 against spec 004's turn; the turn is now
> 007's: a revision is learning, actions run as model tool calls in a bounded loop, and the meeting offer is made
> once, from a fact read from Postgres. What changes here: **code proposes, the model books**; the lead can
> **decline**, ask for **other times**, or **change the subject** without the offer taking over; the broker
> availability editor is cut (backlog 34); and **spec 009** (reschedule, cancel) follows immediately, so booking
> is built to make it small. See the 2026-09-28 clarifications.

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
5. **Given** options were offered, **When** the lead declines (*"agora não"*, *"prefiro não marcar"*), **Then**
   the proposal is closed, the agent acknowledges without insisting, and it makes no new offer on its own for
   the rest of the conversation — the lead can still ask for a visit later.
6. **Given** options were offered, **When** the lead asks for other times — with or without a constraint such as
   *"só de manhã"* or *"quinta"* — **Then** a new proposal replaces the previous one, honouring the constraint
   where one was given; with nothing that fits, FR-001's no-options path applies.
7. **Given** options were offered, **When** the lead changes the subject (*"e em Vila Mariana, tem algo?"*),
   **Then** the turn is handled like any other — revision, search, a question — the options are not repeated,
   and the proposal stays open, so *"pode ser aquela de quinta então"* two turns later still books it.
8. **Given** a booked meeting, **When** the lead asks who will attend, **Then** the agent names no one and says
   the appointment is in the system — including after a broker took over and handed back.
9. **Given** property cards on screen, **When** the lead presses **Interessado** on one, **Then** *"Interessado em
   <code>"* appears as the lead's message and the reply follows FR-004d for where the conversation stands — for a
   complete script with no offer yet, options for that property.

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
3. *Cut 2026-09-28 — the availability editor moved to backlog 34.*

### Edge Cases

- **No free hour in the horizon**, **a broker with every weekday disabled**, or **an agency with no brokers**: the
  agent does not invent a calendar — it says no times are available right now and keeps any earlier proposal open; it never hands off on its own (FR-001, amended 2026-09-28). **Two leads booking the
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
  it has; with none it MUST NOT propose. It MUST NOT hand the conversation off on its own either (amended
  2026-09-28): it says no times are available right now, any earlier proposal stays open, and a lead who wants a
  person can ask for one — the existing handoff trigger. The same holds when nothing matches a constraint the lead
  added (FR-005b).
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
  for the same conversation MUST replace the previous one rather than accumulate — by cancelling the open
  proposed row and inserting the new one, through the same transition function every status change uses.
  Proposed appointments MUST NOT block availability; confirmed ones do.
- **FR-004b**: A viewing MUST be about the property the lead pointed at, when they pointed at one. The extraction
  MUST read a reference to a shown property — its position among the latest cards (*"o segundo"*) or its code
  (*"VMA-0005"*) — and code MUST resolve it against the properties **already shown in this conversation**, never the
  catalog at large. The resolved property is recorded with the turn, proposing uses the most recent one, and the
  confirmation names it (FR-006). A reference that resolves to nothing is ignored, never guessed.
- **FR-004c**: Each property card in the chat widget MUST offer a button labelled **"Interessado"**. Pressing it
  posts the message *"Interessado em VMA-0005"* (the card's code) **on the lead's behalf**: it appears in the
  transcript as the lead's own message and starts a turn exactly as a typed one would. The button MUST be shown on
  hover or keyboard focus with a pointer, and **always** on touch screens, which have no hover — tappable at 390 px
  (constitution principle X).
- **FR-004d**: The reply to an interest in a property depends on where the conversation stands:
  - **script incomplete** → acknowledge the property, and the script continues;
  - **script complete, no offer made yet** → the options, for that property;
  - **a proposal open** → a new proposal for that property, replacing the open one (FR-004);
  - **declined earlier** → treated as the lead asking again (FR-005a), so options for that property;
  - **already booked** → several bookings are spec 009; until then, spec 007 FR-023's honest *"ainda não consigo
    te ajudar com isso"*.
- **FR-004a**: Proposing MUST be triggered by code when the offer is due — spec 007's `shouldProposeMeeting`
  with its offer-outstanding fact — never by the model deciding on its own that it is time to offer. The reply
  MUST present the computed options, replacing today's instruction to ask which weekday suits the lead.
- **FR-005**: Booking MUST accept the index of an offered option or an explicit date and time, MUST validate both
  against FR-002 before confirming, and on failure MUST return the reason to the agent so it can explain and
  re-propose, creating no appointment. Booking MUST be a **tool the model calls** on spec 007's action loop, with
  the contract discipline of 007 FR-013a/b: when to call and when not to, and a readable refusal.
- **FR-005a**: A lead MUST be able to **decline** an offer. The decline MUST be read by the extraction and acted on
  by code, and only while a proposal is open — a "não" to anything else is not a decline. It MUST close the open
  proposal, MUST NOT count as a misunderstanding, and MUST stop the agent from offering again on its own for the
  rest of the conversation; a later request from the lead to visit or talk to someone MUST still reach proposing.
  The acknowledgement MUST say so (*"sem problema — se quiser marcar depois, é só pedir"*), so a decline the
  model misread costs the lead one sentence, not the booking. A decline turn MUST NOT offer the booking tool.
- **FR-005b**: A lead MUST be able to ask for **other times**, optionally with a weekday or period constraint. The
  request MUST be read by the extraction, alongside the facts it already reports, and code MUST re-propose — the
  model does not propose, even here. The new proposal MUST replace the previous one (FR-004). Where nothing
  satisfies FR-002 and the constraint, FR-001's no-options path applies. A request that arrives **before the
  script is complete** — before the name and contact that consent makes available — MUST NOT propose: the agent
  acknowledges it and the script continues, and the offer comes once the script is complete. Completeness is the
  same check `shouldProposeMeeting` makes, without its offer-outstanding clause.
- **FR-005d**: The options MUST be written by code, like spec 007's reconfirmation, not phrased by the model:
  they are dates, times and figures, which the model must not invent and which the `unbackedFigure` guard
  would otherwise reject. The confirmation card (FR-006) is likewise rendered from the booked row.
- **FR-005e**: No scheduling **data path** — proposing, booking, confirming, following up — may carry the assigned
  broker's identity to the model. Code-written sentences MUST refer to *"alguém da nossa equipe"* or *"um
  corretor"*. Asked who will attend, the agent MUST say it can't say yet and that the appointment is in the system.
  A broker's name can still reach the model for another reason: that broker spoke in the conversation and handed
  it back. In that case the agent MUST neither confirm nor deny that this broker will attend. Everything else that
  broker said still stands, and the handback instructions MUST be narrowed accordingly rather than contradicted.
  Consistent with spec 007 FR-019, which already lists broker assignment as protected.
- **FR-005f**: The booking tool MUST be offered only on a turn where the extraction reports that the lead **picked
  an offered option or named a time** while a proposal is open — so a proposal left open through a change of
  subject costs no extra model round trip on the turns that don't answer it (spec 007's promise that a turn taking
  no action costs what it costs today).
- **FR-005g**: When more than one kind of reply applies to a turn, exactly one decides what the reply says, in
  this order: **(1)** a booking confirmation, **(2)** the time options, **(3)** a search result — cards, or that
  nothing matched, **(4)** the answer to a question about criteria or results, **(5)** a reconfirmation, **(6)** the
  script's next question. What the lead most needs to know comes first. This extends spec 007 FR-032, which ranked
  (3)–(6). A **decline acknowledgement** does not compete: it is a short code-written sentence placed **before**
  whatever wins, and it suppresses only what a decline makes pointless — the options and the reconfirmation.
- **FR-005c**: An open proposal MUST NOT take over the conversation. A message that does not answer it MUST be
  handled by the normal turn; the options MUST NOT be repeated on every following turn; and the proposal MUST
  stay open, so a later pick still books it, until it is booked, declined or replaced.
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
- **FR-008a**: *Cut 2026-09-28 — the availability editor moved to backlog 34. Availability stays seeded.*
- **FR-008b**: The dashboard's *Visita marcada* filter and label MUST be derived from the lead having a
  **confirmed future appointment**, not from the pipeline stage. Stages move forward only (ADR 19), so a meeting
  cancelled from the agenda would otherwise leave the lead marked *Visita marcada* with no meeting at all.

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
  the pending question. It MUST NOT quote proposed times: options go stale while a lead is quiet, and booking
  re-validates any pick anyway, so a follow-up about an open proposal invites the lead back rather than
  restating times that may have passed.
- **FR-015**: It MUST be delivered through the same channel abstraction as any other agent message and through
  the Notifier/SSE path — never a polling read — stored as an agent message marked as a follow-up, visible in the
  widget whether open at the time or reopened later.
- **FR-016**: A successful send MUST emit `followup.sent` with `actorType: worker` and the composing call's
  Langfuse `traceId` (trace name `followup.send`, session id = the conversation id), increment the attempt count,
  and schedule the next attempt at `FOLLOWUP_BACKOFF_FACTOR` times the previous interval until the maximum is
  reached; after the final unanswered attempt `conversations.followupState` becomes `exhausted` — *Sem resposta*.

**Demonstration and configuration**

- **FR-017**: The lead drawer MUST offer an action making the lead's pending attempt due immediately, unavailable
  with an explanation when there is none **or when the agency's follow-up switch is off** (FR-019). The seeded stale lead MUST carry an attempt already due, so the first
  sweep after a fresh start sends a follow-up unaided.
- **FR-018**: The first delay MUST be configured in minutes, replacing the hours key; `SCHEDULING_MIN_NOTICE_MINUTES`
  replaces the fixed 24-hour rule, `SCHEDULING_PREFERRED_TIMES` replaces the fixed preferred-hour list, and
  `FOLLOWUP_BACKOFF_FACTOR` replaces the hard-coded ×3. Schema, example file and its test MUST stay in step in the
  same change, and the demonstration values — `FOLLOWUP_FIRST_DELAY_MINUTES=5`, `WORKER_SWEEP_INTERVAL_MS=15000`
  — MUST be documented apart from the production-shaped defaults.

- **FR-019**: A sales manager MUST be able to switch automatic follow-up **on or off for the whole agency**, from
  the leads dashboard, persisted on the agency and on by default. The switch MUST be checked **when an attempt is
  about to be sent**, as one more condition of FR-012's eligibility — not when attempts are scheduled. An attempt
  that comes due while the switch is off MUST be cancelled without sending (FR-013).
- **FR-013a**: An attempt cancelled because the conversation stopped being eligible — the switch, an opt-out, a
  pause, a confirmed booking — MUST return `conversations.followupState` to `none` unless it is `exhausted`, so
  the dashboard never shows a follow-up that no attempt is behind. The demo trigger (FR-017)
  obeys the switch too. A broker MUST see its state and MUST NOT be able to change it.

### Key Entities

- **Appointment** — a meeting between a lead and a broker, optionally about a property, with an instant, a type
  (*viewing* · *call*) and a state moving *proposed* → *confirmed* → *done* or *cancelled*.
- **Follow-up attempt** — one scheduled reengagement, with its attempt number, due time and state; at most one
  pending per conversation, mirrored by `conversations.followupState` (`none | pending | exhausted`). **Broker
  assignment** — set at the first proposal by specialization-filtered rotation, falling back to any broker.
  **Broker availability** — per-weekday `{ enabled, start, end }` on `users.availability`, seeded Mon–Fri
  09:00–18:00; its editor is deferred to backlog 34. No new tables: each is defined by
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
- **SC-011**: *Withdrawn 2026-09-28 with the availability editor (backlog 34).*
- **SC-012**: Every proposal for an `investment` lead is a `call` with no property, from a specialist broker.
- **SC-014**: With the agency's switch off, a due attempt is cancelled and nothing reaches the lead; switched back
  on, the next attempt to come due is sent. A broker sees the switch but cannot change it.
- **SC-015**: No proposal, booking, confirmation or follow-up passes an assigned broker's name to the model; and
  asked *"quem vai me atender?"*, the agent names no one — including after a broker took over and handed back.
- **SC-017**: For each pair of reply kinds that can meet in one turn, the higher-ranked one decides the reply; and a
  decline arriving with a criterion change gets the acknowledgement followed by the search result.
- **SC-016**: A viewing booked after the lead pointed at a card — by *"o segundo"*, by its code, or by the card's
  interest button — carries that property, and its confirmation names the code. The button works by tap at 390 px.
- **SC-013**: In scripted conversations: a decline is never followed by an unprompted offer; a request for other
  times yields a replacing proposal; a change of subject after an offer gets its own answer without the options
  repeated, and a pick two turns later still books.

## Clarifications

### Session 2026-09-28 (after spec 007)

- Q: Who triggers proposing times and booking one? → A: **Code proposes, the model books.** Refined the same day: booking is the *only* new tool. A decline and a request for other times are read by the extraction, like `askedForHuman`, and code acts on them — one tool added to the loop rather than three, which is the Gemma playbook's bring-up order; and the options are code-written, since they are dates and figures. When the offer is due — already decided in code by `shouldProposeMeeting` and `offerOutstanding` (spec 007 FR-017) — code computes the options and the reply presents them. When the lead picks (*"a segunda"*, *"quinta às 10"*), the model calls a booking tool on 007's action loop, and the tool re-validates. The same split as search in 007: deterministic where the decision is, the model only where it must understand the lead.
- Q: Can the lead get out of an offer? → A: Yes, three ways, none of which the offer may block: **decline** it; ask for **other times** (optionally *"só de manhã"*, *"quinta"*); or **change the subject** — other neighbourhoods, and later the investment specialist or general questions — which the normal turn handles while the offer stays open to pick later.
- Q: Keep the per-broker availability editor? → A: No. Cut to protect the 08/10 deadline; recorded as backlog 34, a low-priority extra. Seeded availability drives the slot computation unchanged.
- Q: How does this slice prepare for spec 009? → A: 009 (reschedule, cancel from the conversation) follows immediately. Booking is built as transitions of **one appointment row**, so a reschedule re-runs this spec's own validation (FR-002) on that row rather than opening a second path.

### Session 2026-09-28 (after /speckit-analyze)

- Q: May the lead learn which broker will attend? → A: **No.** The model never receives the assigned broker's name — not when proposing, not after booking. Code-written sentences say *"alguém da nossa equipe"*; asked for a name, the agent says it can't say yet and that the appointment is in the system. After a handback it neither confirms nor denies that the broker who spoke will attend: the team calendar is internal and assignments change last minute. A lead who insists is left to the existing frustration handling. Spec 007 FR-019 already protects broker assignment; this conforms to it rather than amending it.
- Q: How is the booking call kept from costing a round trip on every turn while a proposal is open? → A: A new extraction fact — **the lead picked an offered option or named a time** — gates it.
- Q: How does *Visita marcada* stay true when a meeting is cancelled, given stages only move forward (ADR 19)? → A: The dashboard derives it from **appointments** — a confirmed future one — not from the stage.
- Q: When several kinds of reply apply to one turn, which does the lead get? → A: One, ranked: confirmation › options › search result › criteria/results answer › reconfirmation › script question (FR-005g). The decline acknowledgement is a prefix, not a competitor — *"agora não — mas tem algo em Moema?"* gets the acknowledgement **and** the Moema results.
- Q: Does "no options" still hand the lead to a human? → A: **No automatic handoff**, ever, from FR-001. The agent says no times are available and keeps any earlier proposal open; a lead who wants a person asks — the existing trigger.
- Q: How does a viewing know which property it is about? → A: A new extraction fact resolved against the properties already shown in the conversation (FR-004b), fed also by a button labelled **"Interessado"** on each card that posts *"Interessado em <code>"* on the lead's behalf (FR-004c).
- Q: Can a lead hold several bookings? → A: **Spec 009**, together with reschedule and cancel, since all three need "which appointment do you mean?". 006 books one at a time and must not preclude more.
- Q: Can an agency manager switch automatic follow-up off? → A: Yes, one agency-wide switch. It gates the **send**, not the enqueue: attempts keep being scheduled, and one that comes due while the switch is off is cancelled without sending, the same treatment as any other failed eligibility check.

### Session 2026-09-05

Resolved by the author against `docs/` before planning; `docs/decisoes-pendentes.md` has nothing open here.

- **Q**: `appointment.proposed` carries one `appointmentId`, but three options are shown — what does that id
  point at? → **A**: One row per proposal, created *proposed* at the first option's time, the options carried in
  the message metadata; booking moves that same row to *confirmed*, so both events name one id.
- **Q**: What if the broker has no free preferred hour? → **A**: Search forward ten business days; offer fewer
  than three if that is all there is; with zero, do not propose — ask the lead for a time and raise a handoff. *(Superseded 2026-09-28: no automatic handoff — see FR-001.)*
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

- **Spec 007 owns the turn** ([spec 007](../007-revisable-orchestration/spec.md), superseding 004's orchestration). This slice gives its action
  loop **one** tool — booking — and has code invoke proposing when 007 says the offer is due, when the lead asks
  for other times, and close the proposal when the lead declines, all read by the extraction; and adds the enqueue at the end of a turn and the cancellation on an inbound message. It does not change
  how a turn is orchestrated.
- **Spec 009 follows immediately.** Booking is built as transitions of one appointment row, so 009's reschedule
  re-runs FR-002 on that row and its cancel is one more transition — two tools, no second path. **Spec 005
  owns the worker's consumer registry and the lead drawer**: this slice registers a consumer through
  `register(consumer: { name, run(ctx) })` and adds one action to the drawer's actions row.
- **Spec 002 owns the seed**, to which this slice adds the due pending attempt for the stale demonstration lead;
  **spec 003 owns the shell**, whose `/agenda` placeholder this replaces. The summary spec 005 generates
  asynchronously usually exists; a follow-up composed before it lands falls back to slot state.
- **Business days are Monday to Friday**, with no holiday calendar — a POC with one seeded agency has no source
  of truth for holidays. **Integration tests run inside the container** against the project's Postgres; the one
  model-dependent test uses the local oMLX model, tagged so the default suite skips it.

## Out of Scope

- Any calendar visualisation: the agenda is a list, deliberately. Rescheduling or cancelling from the
  conversation is **spec 009**, built right after this slice; here a broker changes status from the agenda.
- **Several bookings per lead** — different properties, or a later call with an investment specialist — is also
  **spec 009**. Nothing here may assume one appointment per conversation: only *open proposals* are one per
  conversation.
- External calendar integration, invitation e-mail, reminder notification; follow-up on any channel but the web
  widget. Broker capacity limits, holiday calendars, and reassigning a lead between brokers — that last one
  belongs to spec 005's manager view. The broker availability editor — backlog 34; availability stays seeded.
