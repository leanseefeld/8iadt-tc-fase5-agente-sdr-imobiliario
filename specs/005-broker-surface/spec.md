# Feature Specification: Broker Surface

**Feature Branch**: `005-broker-surface` | **Created**: 2026-09-05 | **Revised**: 2026-09-20 | **Status**: Draft

**Input**: Backlog 005 (items 7 + 8 + 9) — the leads dashboard, the lead panel, the
asynchronous AI summary and handoff (assume, reply by hand, return). Covers
*resumo inteligente · dashboard mínimo · priorização de leads*.

Everything here reads columns spec 004 already writes. Nothing here talks to a lead
except the takeover path of US2.

**Scope cut, 2026-09-20.** The score, qualification, handoff and meeting **rules**
left this spec. They depend on two decisions — ADR 20's uncapped score and the open
decision 6 on how the conversation asks — and belong to the spec that implements
them. This one displays what is stored and never computes it.

**Built by 004, checked against this spec on 2026-09-16** (unit suite, database, and a
live probe past qualification — `scripts/probe-after-qualification.ts`):

| Piece | Verdict |
|---|---|
| Score stored per turn | Works. Seeded scores disagree with the formula, and the formula itself is being replaced (ADR 20) — out of scope here. |
| Handoff, pause, meeting offer | Work, but fire wrongly after qualification (decision 6). Named here so nobody reports them as this slice's defects. |
| Paused means silent | Verified in 004 T047. |
| Sweep registry | Matches `modelo-de-dados.md` §6. Append to it. |
| Notifier | Per conversation only; no agency stream, no status push. |
| Broker reply path | Persists and notifies `role='broker'`; no author, no hold check, no `conversation.turn`, rendered as an agent bubble. |
| Scope, reassign (003) | Match. The seed assigns no lead, so *Meus leads* is empty for Ana. |
| Seed summary data | `previewLine` holds the last agent message; no summaries, no turn events. |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The morning queue (Priority: P1)

A broker opens `/leads` and sees, without clicking, how the operation is doing and who
to call first.

**Independent Test**: sign in as a broker and as a manager; check tiles, filters, search, scoping, ordering and live updates.

1. **Given** leads in scope, **When** the screen loads, **Then** four tiles sit above a list ordered by score, then most recent lead message.
2. **Given** the list, **When** *Aguardando corretor* is chosen, **Then** only paused conversations with no holder remain, surviving a reload.
3. **Given** a broker, **Then** *Meus leads* starts on; **given** a manager, it starts off.
4. **Given** the screen open, **When** a lead replies, **Then** the row updates over SSE with scroll, filter, search and toggle intact.

### User Story 2 - Read the lead, then take it over (Priority: P1)

Summary first, qualification second, transcript third. Any broker may assume any lead at
any stage, reply by hand while the agent stays silent, and hand it back.

**Independent Test**: open a lead by URL, take it over, reply, see it in the widget, hand back.

1. **Given** a stored summary, **When** the panel opens, **Then** it is first, timestamped, and empty slots read *— não informado*.
2. **Given** an open panel, **When** Escape or back is used, **Then** it closes and the list keeps filter, search and scroll.
3. **Given** any lead, **When** a broker assumes it, **Then** the conversation pauses under that broker, the widget shows the badge within one push **without any message being sent**, and lead messages get no agent reply.
4. **Given** a conversation the broker holds, **When** they reply, **Then** the widget shows it labelled as a person; **when** they hand it back, the agent answers the next lead message.

### User Story 3 - The summary writes itself (Priority: P2)

The worker summarises off the reply path; a slow or dead summariser costs the lead nothing.

1. **Given** several unsummarised turns, **When** the worker sweeps, **Then** one summary is produced and every pending turn is marked handled.
2. **Given** a turn three seconds old, **When** the worker sweeps, **Then** that conversation waits for the next sweep.
3. **Given** the provider down, **When** the worker sweeps, **Then** the sweep completes, the stored summary is untouched, the failure is logged.

### Edge Cases

- No name, contact or summary yet — *Lead anônimo*, empty table, no preview line.
- 006's events absent — its tiles read zero, not *N/A*.
- Two workers sweeping — one summary per conversation, all turns cleared.
- A second broker assuming a held conversation — fails with a message. A lead replying while a broker types — nothing lost, nothing misattributed.
- A pasted URL outside scope — not found.
- PII in a summary — the broker reads it; traces and logs do not.
- A phone — rows legible, panel full screen.

## Requirements *(mandatory)*

**Pipeline stage**

- **FR-007**: `leads.status` moves forward only along `new → qualifying → qualified → scheduled → visited → won | lost`. The agent owns stages up to `qualified` (004); a broker MAY set `won`/`lost` from any stage, and `visited` through 006's action. Conversation and follow-up state are separate axes (`modelo-de-dados.md` §7).

*(FR-001 to FR-006 — scoring, qualification, handoff and meeting rules — moved to the spec that implements ADR 20 and decision 6.)*

**Asynchronous summary**

- **FR-008**: The worker MUST summarise by claiming unprocessed `conversation.turn` events so concurrent workers never summarise one conversation twice.
- **FR-009**: At most one summary per conversation per sweep.
- **FR-010**: A conversation whose latest turn is newer than `SUMMARY_DEBOUNCE_SECONDS` MUST wait for the next sweep.
- **FR-011**: The summariser receives the previous summary plus only the messages since it.
- **FR-012**: It produces a 2–4 sentence pt-BR summary (a prompt instruction) and a preview line of at most 90 characters (enforced in code).
- **FR-013**: Summary, preview line, consumed turns and `summary.updated` are written atomically.
- **FR-014**: The call is traced as `summary.generate`, session id = conversation id, PII masked in traces and logs.
- **FR-015**: Summarisation MUST NOT run on, or delay, the reply path.
- **FR-016**: A failed summary leaves the stored one untouched, clears its turns, and is never retried in a loop.
- **FR-017**: The summariser is a `SweepConsumer` appended to the existing `jobs/consumers.ts`.

**Leads dashboard**

- **FR-018**: Four tiles for the scope, cumulative: median first response (`lead.created` → first agent message), qualification rate (leads at `qualified` or beyond, over all leads), confirmed appointments, leads recovered by follow-up.
- **FR-019**: Every query is scoped by agency. *Meus leads* narrows to the user's own leads and defaults from `scopeForUser().defaultOwnLeadsOnly`.
- **FR-020**: The list MUST offer the filters *Ao vivo*, *Aguardando corretor*, *Visita marcada*, *Sem resposta*, the *Meus leads* toggle and a free-text search over name, phone, e-mail and preview line — all in the URL.
- **FR-021**: A row MUST show a temperature dot and label, name or *Lead anônimo*, intent, the neighborhoods · price · bedrooms line, the preview line in quotes, a conversation chip (*Agente respondendo* · *<Nome> no comando* · *Aguardando corretor* · *Encerrada*), a stage chip, and a live dot when `lastLeadMessageAt` is within `DASHBOARD_LIVE_WINDOW_MINUTES`.
- **FR-022**: Ordered by score descending, then last lead message descending, and paginated.
- **FR-023**: The screen MUST update over an agency-scoped SSE stream — no polling — keeping scroll, filter, search and toggle.
- **FR-024**: Temperature MUST be a colored dot **and** a word. No emoji on any dashboard surface.
- **FR-025**: Every empty result MUST render an explanatory state.

**Lead panel**

- **FR-026**: The panel is addressable by URL and closes with the browser's back button.
- **FR-027**: Sections in order: header, AI summary with the time it was regenerated, qualification, actions, transcript, timeline.
- **FR-028**: Every script slot appears; empty ones read *— não informado*.
- **FR-029**: The transcript shows the whole conversation, never truncated, roles distinct, property cards compact, broker messages labelled as written by a person.
- **FR-030**: The timeline renders events as pt-BR sentences naming the actor, with times. Entries carrying a `traceId` link to the Langfuse UI on `LANGFUSE_UI_PORT`.
- **FR-031**: Escape closes and restores focus; full screen on a phone; a lead outside scope behaves as if it does not exist.

**Handoff**

- **FR-032**: Assuming works at any stage, pauses the conversation, sets `heldByUserId`, records `conversation.assumed`, and fails with a message rather than overwriting an existing holder. It assigns the lead only when unassigned.
- **FR-033**: A paused conversation gets no agent reply (built by 004).
- **FR-034**: A broker reply MUST be stored with `role='broker'` and `metadata.userId` and delivered over the widget's SSE stream. A state change — assume or return — MUST also reach that stream without waiting for a message.
- **FR-035**: The reply box is enabled only while the signed-in user holds the conversation, and says why when it is not.
- **FR-036**: Returning sets `active`, clears `heldByUserId` and records `conversation.returned`.
- **FR-037**: The panel changes stage along FR-007 (`lead.status_changed`, actor `user`); only a sales manager may reassign (`lead.reassigned`).
- **FR-038**: `paused` with no holder reads *Aguardando corretor* on the chip, in the panel and through the filter, whatever the stage.

### Key Entities

No new tables. Lead (`status`, `assignedBrokerId` — `score` is read, never written here),
Conversation (`summary`, `previewLine`, `summaryUpdatedAt`, `status`, `heldByUserId`),
Message (the `broker` role), Event (metrics, timeline, outbox).

## Success Criteria *(mandatory)*

- **SC-002**: A broker identifies the top-priority lead within 20 seconds of load, without opening a panel.
- **SC-003**: `/leads` renders under 1.5 s with 500 leads, and its query count does not grow with rows.
- **SC-004**: *Meus leads* on shows only the user's own leads — by list, search and URL; off shows the agency.
- **SC-005**: After a four-turn conversation goes quiet, summary and preview line are stored within two sweeps; the preview is at most 90 characters.
- **SC-006**: With the provider stopped, every broker screen renders and the lead still gets 004's fallback reply.
- **SC-007**: Two concurrent workers produce exactly one summary per conversation.
- **SC-008**: A takeover reaches the widget within one SSE push, with no message sent, and the agent produces zero replies while paused.
- **SC-009**: Every broker-facing string is pt-BR, with no emoji.
- **SC-010**: The panel is keyboard-operable with focus return, and neither list nor panel scrolls sideways at 390 px.

*(SC-001, the scoring table, moved with FR-001 to FR-006.)*

## Clarifications

- **Metric period?** → Cumulative, no window.
- **Search over?** → Name, phone, e-mail, preview line. Not the transcript.
- **Does assuming assign the lead?** → Only when it has no broker. Reassignment stays a manager action.
- **Summariser failure?** → Turns cleared, stored summary kept, failure logged; the next lead message triggers a fresh attempt.
- **Aguardando corretor?** → `status='paused'` with `heldByUserId` null, any stage.
- **Why a toggle instead of a role scope?** → One agency query for both roles; the toggle is a default, not a permission.
- **Qualification rate from events or from status?** → From `leads.status`. The `lead.qualified` event is not written today and its definition moves with the scoring spec; the stage says the same thing with one fewer dependency.

## Assumptions

- 002, 003 and 004 are merged; the verdict table above says what that actually provides.
- The event catalog (`modelo-de-dados.md` §4) is closed; nothing is invented here.
- 006's tiles read zero until 006 lands.
- Defaults: debounce 20 s, 25 rows per page.
- Scores on screen are today's, including the seeded ones that disagree with the formula. ADR 20's spec recomputes them; the dashboard reads `temperature(score)`, so the bands follow that function wherever it lands.

## Out of Scope

Scoring, qualification, handoff and meeting rules (ADR 20's spec). Agent behaviour (004).
Appointments, agenda, follow-up (006). Charts, notifications, editing, bulk actions,
export, CRM, a second channel.
