# Feature Specification: Broker Surface

**Feature Branch**: `005-broker-surface` | **Created**: 2026-09-05 | **Status**: Draft

**Input**: Backlog spec 005 — *Broker surface* (original items 7 + 8 + 9): the
deterministic lead score, the asynchronous AI summary, the leads dashboard, the
lead panel, and handoff — assume the conversation, reply by hand, hand it back.
Turns open decisions 1 and 5, answered by ADR 11, into code. Covers *resumo
inteligente · dashboard mínimo · priorização de leads*.

Spec 004 makes the agent talk; this slice is what a broker opens in the morning
and what a jury watches during the demo. Everything here reads state that 004
wrote. Nothing here talks to a lead except through the handoff path of User Story 3.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Priority the broker can trust (Priority: P1)

Every lead carries a number from 0 to 100 and a temperature derived from it, from
arithmetic over what the lead said — never from the model. A manager who asks "why
is this one at the top?" gets an answer.

**Why this priority**: ordering the queue is the point of the queue, every other story consumes the score, and this is the only part provable without I/O.

**Independent Test**: drive the rule functions over a table of slot states, asserting score, band, qualification and handoff verdict for each.

**Acceptance Scenarios**:

1. **Given** an identified intent and every script slot filled but name and contact, **When** the score is computed, **Then** the lead is qualified and the score matches the published weights exactly.
2. **Given** a lead crossing into qualified on a turn, **When** that turn is persisted, **Then** a qualification event is recorded once, and never again.
3. **Given** a hot lead who has given contact details, **When** the handoff rule runs, **Then** it calls for a broker and the event names the reason.

---

### User Story 2 - The morning queue (Priority: P1)

A broker opens the leads screen and, without clicking, sees how the operation is
doing and who to call first. Hot leads sit at the top; each row carries intent,
budget, neighborhood and the one sentence the AI pulled out of the conversation.

**Why this priority**: the main screen of the product, and what makes the work of specs 004 and 006 visible at all.

**Independent Test**: sign in as a broker with seeded leads; check tiles, filters, search, scoping and ordering. A usable triage screen on its own.

**Acceptance Scenarios**:

1. **Given** leads in the user's scope, **When** the screen loads, **Then** four metric tiles sit above a list ordered by score descending, then by most recent lead message.
2. **Given** the full list, **When** *Quentes* is chosen, **Then** only hot leads remain, and the choice survives a page reload.
3. **Given** a broker signed in, **When** the list loads, **Then** it holds only that broker's leads; a sales manager sees the whole agency.
4. **Given** the screen is open, **When** a lead replies and ten seconds pass, **Then** the row updates with no reload and with scroll, filter and search intact.

---

### User Story 3 - Read the lead, then take it over (Priority: P1)

Opening a lead shows the AI summary first, the qualification second, the transcript
third — a broker with twenty seconds needs only the first two. From the same panel
the broker takes the conversation over, replies by hand while the agent stays
silent, and hands it back when done.

**Why this priority**: the summary is graded and worthless below the fold, and a lead parked as *waiting for a broker* with no way for one to arrive is a dead end.

**Independent Test**: open a seeded lead by URL, check section order and empty slots, take over a live conversation, reply, confirm the widget shows it, hand back.

**Acceptance Scenarios**:

1. **Given** a lead with a stored summary, **When** its panel opens, **Then** the summary is the first section, carrying the time it was last regenerated, and every empty slot reads *— não informado* rather than blank.
2. **Given** an open panel, **When** Escape or the back button is used, **Then** it closes and the list keeps its filter, search and scroll position.
3. **Given** an active conversation, **When** a broker takes it over, **Then** it is paused, the takeover is recorded, and a further lead message gets no agent reply.
4. **Given** a paused conversation, **When** the broker replies, **Then** it is stored as a broker message and reaches the lead through the same channel the agent uses, labelled as coming from a person; **and when** the broker hands it back, the agent answers the next lead message and the return is recorded.

---

### User Story 4 - The summary writes itself (Priority: P2)

Nobody asks for the summary. A conversation happens and shortly afterwards the row
carries a preview line and the panel a fresh summary. The work runs in the worker,
off the reply path, so a slow summariser costs the lead nothing.

**Why this priority**: graded, but every screen above degrades gracefully without it — a lead with no summary still sorts, filters and opens.

**Independent Test**: hold a short conversation, wait one sweep, confirm the summary appears; stop the provider and confirm nothing lead-facing changes.

**Acceptance Scenarios**:

1. **Given** several unsummarised turns, **When** the worker sweeps, **Then** exactly one summary is produced and every pending turn is marked handled.
2. **Given** a conversation whose last turn was three seconds ago, **When** the worker sweeps, **Then** it is left for the next sweep.
3. **Given** the provider is unreachable, **When** the worker sweeps, **Then** the sweep completes, the stored summary is untouched, the failure is logged, and no lead-facing behaviour changes.

---

### Edge Cases

- **A lead with no name, no contact and no summary yet** — every surface renders: *Lead anônimo*, an empty qualification table, no preview line. Normal for the first thirty seconds of a conversation.
- **Events this slice reads but spec 006 emits** — confirmed viewings, follow-up recoveries. Those tiles read zero, not *N/A* and not an error.
- **Two workers sweeping at once**, or one facing a hundred pending turns after an outage: one summary per conversation, all turns cleared, no minutes-long sweep.
- **A second broker takes an already-held conversation** — it fails rather than silently stealing it. **A lead replies while a broker types** — neither message is lost, and the broker's is not attributed to the agent.
- **A pasted URL for a lead outside the user's scope** — not found, not a rendered panel with an authorization error inside it.
- **Personally identifiable information in a summary** — the broker may read it; the trace and the logs of the call that produced it must not carry raw values.
- **The list on a phone** — rows stay legible and the panel takes the whole screen rather than becoming a narrow column.

## Requirements *(mandatory)*

### Functional Requirements

**Score, qualification and handoff**

- **FR-001**: Scoring, temperature, qualification and handoff rules MUST be pure functions over intent and slot state — no I/O, no model call — implementing the weights, cap and bands published in the data model document exactly.
- **FR-002**: The score MUST be recomputed on every turn and stored on the lead, so ordering and filtering never recompute at read time.
- **FR-003**: Crossing into qualified MUST record a qualification event exactly once per lead; later turns that remain qualified MUST NOT record it again.
- **FR-004**: A handoff request MUST be recorded with its reason: the lead asked for a person, two consecutive failures to understand, or hot with contact known.
- **FR-005**: The model MUST NOT assign, adjust or influence the score. Soft signals belong in the preview line, where a broker reads them.
- **FR-006**: Lead status MUST move only along `new → qualifying → qualified → scheduled`, plus `handoff`, reachable from `new`, `qualifying` or `qualified` alike — a lead can ask for a person or exhaust its fallbacks before qualifying finishes, and a broker can take one over at any stage. `scheduled` and `handoff` both lead only to `won | lost`. The unresponsive state is set by spec 006; it is displayed here and never set here.

**Asynchronous summary**

- **FR-007**: The worker MUST summarise by consuming unhandled conversational-turn records from the append-only event trail, claiming them so two workers running at once never summarise one conversation twice.
- **FR-008**: At most one summary MUST be produced per conversation per sweep, however many turns are pending for it.
- **FR-009**: A conversation whose most recent turn is newer than a short debounce MUST be deferred to the next sweep, so no summary lands mid-exchange.
- **FR-010**: The summariser MUST receive the previous summary plus only the messages recorded since it — never the whole transcript.
- **FR-011**: It MUST produce two fields: two to four sentences of Brazilian Portuguese written for a broker, and one key sentence of at most 90 characters for the list row. Over-length output MUST never be stored as-is.
- **FR-012**: Storing the summary, marking the consumed turns handled and recording the summary event MUST happen atomically.
- **FR-013**: The summary call MUST be traced like every other model call, with personally identifiable information masked in the trace and in logs.
- **FR-014**: Summary generation MUST NOT run on the reply path and MUST NOT delay a reply to a lead under any circumstance.
- **FR-015**: A failed summary MUST leave the stored summary untouched, MUST NOT stall the sweep, and MUST NOT cause the same conversation to be retried forever.
- **FR-016**: The sweep MUST run registered consumers rather than a hard-coded sequence, so spec 006's follow-up consumer is added without editing the loop.

**Leads dashboard**

- **FR-017**: The screen MUST show four metrics for the user's scope, all derived from the event trail: median first-response time, qualification rate, confirmed appointments, and leads recovered by follow-up.
- **FR-018**: Every query MUST be scoped to the agency and, unless the user is a sales manager, to that broker's own leads.
- **FR-019**: The list MUST offer the filters *Todos*, *Quentes*, *Aguardando* and *Agendados* plus a free-text search, both surviving a page reload.
- **FR-020**: Each row MUST show temperature, name or *Lead anônimo*, intent, a compact qualification line (neighborhoods · price · bedrooms), the preview line in quotes when one exists, the relative time of the last lead message, and the follow-up state when there is one.
- **FR-021**: The list MUST be ordered by score descending, then most recent lead message descending, and MUST be paginated.
- **FR-022**: The screen MUST refresh about every ten seconds with no persistent connection, losing neither scroll position, filter nor search text, and never moving a row out from under a click.
- **FR-023**: Temperature MUST be conveyed by a colored dot **and** a text label — never by color alone, never by an emoji. No dashboard surface may use emoji.
- **FR-024**: Every empty result — no leads, no matches, no metrics yet — MUST render an explanatory state rather than a blank region.

**Lead panel**

- **FR-025**: The panel MUST be addressable by URL, so it can be linked, opened directly, and closed with the browser's back button.
- **FR-026**: Sections MUST appear in this order: header, AI summary, qualification, actions, transcript, timeline. The summary MUST carry the time it was last regenerated.
- **FR-027**: The qualification table MUST list every slot of the lead's script, showing *— não informado* for each one still empty.
- **FR-028**: The transcript MUST show every message with its role visually distinct, property suggestions rendered compactly, and broker messages labelled as written by a person.
- **FR-029**: The timeline MUST be rendered from the event trail as Portuguese sentences with times, never as raw event names.
- **FR-030**: The panel MUST close on Escape, return focus to the row that opened it, and occupy the full screen on a phone. Opening a lead outside the user's scope MUST behave as if the lead does not exist.

**Handoff**

- **FR-031**: Taking over MUST pause the conversation, record the takeover with the acting user, and put the lead into the handoff status. Taking over a conversation someone already holds MUST fail with a message rather than overwrite it.
- **FR-032**: While a conversation is paused the agent MUST NOT answer it. This is a contract on spec 004's orchestrator; this slice owns the state and the event.
- **FR-033**: A broker reply MUST be stored as a message authored by a broker and delivered to the lead through the same channel abstraction the agent uses.
- **FR-034**: The reply box MUST be enabled only while the conversation is paused, and MUST state why when it is not.
- **FR-035**: Handing back MUST return the conversation to active and record the return, after which the agent answers the next lead message.
- **FR-036**: The panel MUST allow a status change along FR-006's transitions, and MUST offer reassignment to another broker only to a sales manager.
- **FR-037**: A lead whose handoff was requested and whose conversation no broker has taken over MUST read as *Aguardando corretor* and be reachable by the *Aguardando* filter.

### Key Entities

No new tables. This slice fills columns the data model already defines and reads the
trail spec 004 already writes.

- **Lead** — gains a maintained `score` and moves through FR-006's statuses.
- **Conversation** — gains `summary`, `previewLine` and `summaryUpdatedAt`; its `status` becomes the handoff switch, where `paused` means a broker holds it.
- **Message** — the `broker` role becomes reachable for the first time.
- **Event** — the metrics source, the panel timeline, the record of qualification, handoff, takeover, return and summary, and the outbox driving summarisation.

## Success Criteria *(mandatory)*

- **SC-001**: The scoring rules are verified against a table of at least fifteen slot states covering both scripts, every band boundary, the cap at 100 and both bonuses, with zero database and zero model involvement.
- **SC-002**: A broker with seeded data identifies the highest-priority lead within 20 seconds of the screen loading, without opening a panel.
- **SC-003**: The leads screen renders in under 1.5 seconds with 500 leads in the agency, and its query count does not grow as rows are added.
- **SC-004**: A broker never sees another broker's lead — verified by list, by search and by direct URL.
- **SC-005**: After a conversation of at least four turns goes quiet, a summary and preview line are stored within two sweeps; the summary reads as natural Brazilian Portuguese and the preview line is at most 90 characters.
- **SC-006**: With the model provider stopped, every broker screen still renders and the lead conversation still replies through its fallback path — zero user-visible impact from the summariser being down.
- **SC-007**: Two workers running concurrently over a backlog produce exactly one summary per conversation — no duplicates, no skipped conversations.
- **SC-008**: A takeover reaches the lead within one widget poll, and the agent produces zero replies while the conversation is paused.
- **SC-009**: Every string a broker sees is Brazilian Portuguese, and no dashboard surface contains an emoji.
- **SC-010**: The panel is fully operable from the keyboard — open, read, close, focus back on the originating row — and list and panel are both usable with no horizontal scrolling on a 390-pixel viewport.

## Clarifications

Resolved by the author against the architecture documents, since this project has no
interactive clarification step.

- **Q: Over what period are the metric tiles computed?** → **A:** All events in scope, no time window, labelled as cumulative. A window would show four zeros on a days-old data set; a period selector is a later addition.
- **Q: What does the search box search?** → **A:** Case-insensitively over the lead's name, phone, e-mail and stored preview line. Not the transcript — that is a text-search feature, not a triage feature.
- **Q: Does taking over a conversation also assign the lead?** → **A:** Only when the lead has no assigned broker; then the acting user becomes it. An assigned lead is never reassigned by a takeover, so nobody silently steals a colleague's lead. Reassignment stays a sales-manager action.
- **Q: What happens when the summariser fails for a conversation?** → **A:** The claimed turns are marked handled anyway and the stored summary is left alone. A stale summary beats a sweep burning a model call on the same conversation forever; the summary is never load-bearing, and the next lead message triggers a fresh attempt. The failure is logged and visible in the trace.
- **Q: How is *Aguardando corretor* derived, given no such status exists?** → **A:** Lead status `handoff` with the conversation still `active` — requested, not yet taken. Once a broker takes over the conversation is `paused` and the lead reads as being with that broker.

## Assumptions

- **Specs 002, 003 and 004 have landed**: schema and seed; the session cookie with its role-based scoping helper and the authenticated shell; an orchestrator that persists turns and emits the events named in the data model's catalog. This slice adds no table and no navigation item.
- **The event catalog is closed.** Every event written or read here already exists in the data model document; none is invented.
- **Confirmed appointments and follow-up recoveries do not exist yet.** Their tiles read zero until spec 006 lands. That is correct, not broken.
- **Twenty seconds is the debounce** — long enough that a lead typing twice does not cause two summaries, short enough that a broker opening a lead a minute later reads a current one.
- **Twenty-five rows per page**, which fills a laptop screen without scrolling past the metrics.
- **The web widget polls.** A broker reply reaches the lead on its next poll or page load; there is no push channel and none is needed at this scale.
- **The summary is written for a broker, never shown to the lead.**

## Out of Scope

- Any change to how the agent talks, extracts slots or picks a question — spec 004.
- Appointments, the agenda screen, and every follow-up mechanism including the demo trigger button — spec 006.
- Charts. The metrics header is four numbers; a charting dependency for four numbers is not a trade this project makes.
- Notifications of any kind. A qualified lead is visible in the list, which is what the MVP promised.
- Editing leads, properties or users; bulk actions; export; CRM integration. The outbox a CRM consumer would attach to already exists and stays unused.
- Any second channel. The broker reply path goes through the channel abstraction, whose only implementation is the web widget.
