# Feature Specification: Broker Surface

**Feature Branch**: `005-broker-surface` | **Created**: 2026-09-05 | **Revised**: 2026-09-16 (post-004) | **Status**: Draft

**Input**: Backlog 005 (items 7 + 8 + 9) — lead score, async AI summary, leads
dashboard, lead panel, handoff (assume, reply by hand, return). ADR 11 and 19.
Covers *resumo inteligente · dashboard mínimo · priorização de leads*.

Everything here reads state spec 004 writes. Nothing here talks to a lead except
the takeover path of US3.

**Built by 004, checked against this spec on 2026-09-16** (unit suite, DB, and a
live probe past qualification — `scripts/probe-after-qualification.ts`):

| Piece | Verdict |
|---|---|
| Score rules, `isQualified` | Match §3. No headroom for property interest (decision 7); a finished purchase caps at 100. |
| Score stored per turn | Live path yes. Seed scores contradict the formula (85/55/15 vs 100/40/25). |
| `lead.qualified` | Missing on the live path. |
| `handoff.requested`, pause | Works, but fires falsely after qualification: two ordinary messages hand a hot lead off (decision 6). |
| Meeting proposal | Re-proposed on every turn after the script ends; calendar is a stub. |
| Paused means silent | Verified in 004 T047. |
| Sweep registry | Matches §6. |
| Notifier | Per conversation only; no agency stream, no status push. |
| Broker reply path | Persists and notifies `role='broker'`; no author, no hold check, no `conversation.turn`, rendered as an agent bubble. |
| Scope, reassign (003) | Match. Seed assigns no lead, so *Meus leads* is empty for Ana. |
| Seed summary data | `previewLine` holds the last agent message; no summaries, no turn events. |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Priority the broker can trust (Priority: P1)

A 0–100 score and a temperature, from arithmetic, never the model. 004 computes
and stores it; this story adds the one missing record — qualification — and proves
the rules.

**Independent Test**: the existing rule suites plus one persistence test.

1. **Given** a lead crossing into qualified, **When** the turn commits, **Then** `lead.qualified` is recorded once, never again.
2. **Given** a hot lead with contact, **When** the script ends, **Then** a meeting is proposed (a call for `investment`), no handoff fires, the conversation stays `active`.

### User Story 2 - The morning queue (Priority: P1)

A broker opens `/leads` and sees, without clicking, how the operation is doing and
who to call first.

**Independent Test**: sign in as broker and manager; check tiles, filters, search, scoping, ordering, live updates.

1. **Given** leads in scope, **When** the screen loads, **Then** four tiles sit above a list ordered by score, then most recent lead message.
2. **Given** the list, **When** *Aguardando corretor* is chosen, **Then** only paused conversations with no holder remain, surviving a reload.
3. **Given** a broker, **Then** *Meus leads* starts on; **given** a manager, it starts off.
4. **Given** the screen open, **When** a lead replies, **Then** the row updates over SSE with scroll, filter, search and toggle intact.

### User Story 3 - Read the lead, then take it over (Priority: P1)

Summary first, qualification second, transcript third. Any broker may assume any
lead at any stage, reply by hand while the agent is silent, and hand it back.

**Independent Test**: open a lead by URL, take it over, reply, see it in the widget, hand back.

1. **Given** a stored summary, **When** the panel opens, **Then** it is first, timestamped, and empty slots read *— não informado*.
2. **Given** an open panel, **When** Escape or back is used, **Then** it closes and the list keeps filter, search and scroll.
3. **Given** any lead, **When** a broker assumes it, **Then** the conversation pauses under that broker, the widget shows the badge within one push, and lead messages get no agent reply.
4. **Given** a paused conversation, **When** the broker replies, **Then** the widget shows it labelled as a person; **when** handed back, the agent answers the next lead message.

### User Story 4 - The summary writes itself (Priority: P2)

The worker summarises off the reply path; a slow or dead summariser costs the lead nothing.

1. **Given** several unsummarised turns, **When** the worker sweeps, **Then** one summary is produced and every pending turn is marked handled.
2. **Given** a turn three seconds old, **When** the worker sweeps, **Then** that conversation waits for the next sweep.
3. **Given** the provider down, **When** the worker sweeps, **Then** the sweep completes, the stored summary is untouched, the failure is logged.

### Edge Cases

- No name, contact or summary yet — *Lead anônimo*, empty table, no preview line.
- 006's events absent — its tiles read zero.
- Two workers sweeping — one summary per conversation, all turns cleared.
- A second broker assuming a held conversation — fails with a message. A lead replying while a broker types — nothing lost, nothing misattributed.
- A pasted URL outside scope — not found.
- PII in a summary — the broker reads it; traces and logs do not.
- A phone — rows legible, panel full screen.

## Requirements *(mandatory)*

**Score, qualification, handoff and meeting**

- **FR-001**: Score, temperature, qualification, handoff and meeting rules are pure functions per `modelo-de-dados.md` §3. *Rules built by 004; weights reopen with decision 7.*
- **FR-002**: The score is recomputed and stored every turn, and seeded scores MUST equal the formula.
- **FR-003**: Crossing into qualified MUST record `lead.qualified` exactly once per lead.
- **FR-004**: A handoff request is recorded with reason `asked` or `fallback`, and MUST NOT fire on messages the agent understood (decision 6).
- **FR-005**: A finished script proposes a meeting — a viewing for a hot `purchase`/`rental` lead with contact, a call for `investment` — once, and never pauses the conversation (decision 6).
- **FR-006**: The model MUST NOT influence the score.
- **FR-007**: `leads.status` moves forward only along `new → qualifying → qualified → scheduled → visited → won | lost`. The agent owns stages up to `qualified` (004); a broker MAY set `won`/`lost` from any stage and `visited` via 006's action. Conversation and follow-up state are separate axes (`modelo-de-dados.md` §7).

**Asynchronous summary**

- **FR-008**: The worker MUST summarise by claiming unprocessed `conversation.turn` events so concurrent workers never summarise one conversation twice.
- **FR-009**: At most one summary per conversation per sweep.
- **FR-010**: A conversation whose latest turn is newer than `SUMMARY_DEBOUNCE_SECONDS` MUST wait for the next sweep.
- **FR-011**: The summariser receives the previous summary plus only messages since it.
- **FR-012**: It produces a 2–4 sentence pt-BR summary (prompt instruction) and a preview line of at most 90 characters (enforced in code).
- **FR-013**: Summary, preview line, consumed turns and `summary.updated` are written atomically.
- **FR-014**: The call is traced as `summary.generate`, session id = conversation id, PII masked in traces and logs.
- **FR-015**: Summarisation MUST NOT run on or delay the reply path.
- **FR-016**: A failed summary leaves the stored one untouched, clears its turns, and is never retried in a loop.
- **FR-017**: The summariser is a `SweepConsumer` appended to `jobs/consumers.ts` (built by 004).

**Leads dashboard**

- **FR-018**: Four tiles for the scope, from the event trail, cumulative: median first-response time, qualification rate, confirmed appointments, leads recovered.
- **FR-019**: Every query is scoped by agency. *Meus leads* narrows to the user's own leads; it defaults from `scopeForUser().defaultOwnLeadsOnly`.
- **FR-020**: Filters *Ao vivo*, *Aguardando corretor*, *Visita marcada*, *Sem resposta*, the toggle and a search — all in the URL.
- **FR-021**: A row shows temperature dot and label, name or *Lead anônimo*, intent, neighborhoods · price · bedrooms, preview line in quotes, a conversation chip (*Agente respondendo* · *<Nome> no comando* · *Aguardando corretor* · *Encerrada*), a stage chip (or *Visita <dia> <hora>*), and a live dot within `DASHBOARD_LIVE_WINDOW_MINUTES`.
- **FR-022**: Ordered by score desc, then last lead message desc; paginated.
- **FR-023**: Live updates over an agency-scoped SSE stream — no polling — keeping scroll, filter, search and toggle.
- **FR-024**: Temperature is a dot **and** a word. No emoji on any dashboard surface.
- **FR-025**: Every empty result renders an explanatory state.

**Lead panel**

- **FR-026**: The panel is addressable by URL and closes with back.
- **FR-027**: Order: header, AI summary (with its time), qualification, actions, transcript, timeline.
- **FR-028**: Every script slot is listed; empty ones read *— não informado*.
- **FR-029**: The whole transcript, never truncated; roles distinct; cards compact; broker messages labelled as a person's.
- **FR-030**: The timeline renders events as pt-BR sentences naming the actor, with times. Entries with a `traceId` link to the Langfuse UI on `LANGFUSE_UI_PORT`.
- **FR-031**: Escape closes and restores focus; full screen on a phone; out of scope behaves as not found.

**Handoff**

- **FR-032**: Assuming works at any stage, pauses the conversation, sets `heldByUserId`, records `conversation.assumed`, and fails rather than overwrite an existing holder. It assigns the lead only when unassigned.
- **FR-033**: A paused conversation gets no agent reply (built by 004).
- **FR-034**: A broker reply is stored with `role='broker'` and `metadata.userId`, and delivered over the widget's SSE stream. A status change (assume, return) MUST also reach the widget's stream without waiting for a message.
- **FR-035**: The reply box is enabled only while the user holds the conversation, and says why otherwise.
- **FR-036**: Returning sets `active`, clears `heldByUserId`, records `conversation.returned`.
- **FR-037**: The panel changes status along FR-007 (`lead.status_changed`, actor `user`); only a manager may reassign (`lead.reassigned`).
- **FR-038**: `paused` with no holder reads *Aguardando corretor* on the chip, in the panel and in the filter, whatever the stage.

### Key Entities

No new tables. Lead (`score`, `status`, `assignedBrokerId`), Conversation
(`summary`, `previewLine`, `summaryUpdatedAt`, `status`, `heldByUserId`), Message
(`broker` role), Event (metrics, timeline, outbox).

## Success Criteria *(mandatory)*

- **SC-001**: The rule suites (`tests/score.test.ts`, `tests/handoff.test.ts`) cover both scripts, both bonuses, the cap, both band boundaries and both meeting kinds, with no database or model.
- **SC-002**: A broker identifies the top-priority lead within 20 s of load, without opening a panel.
- **SC-003**: `/leads` renders under 1.5 s with 500 leads; query count does not grow with rows.
- **SC-004**: *Meus leads* on shows only own leads — by list, search and URL; off shows the agency.
- **SC-005**: After a four-turn conversation goes quiet, summary and preview line are stored within two sweeps; preview ≤ 90 chars.
- **SC-006**: With the provider stopped, broker screens render and the lead still gets the fallback reply.
- **SC-007**: Two concurrent workers produce exactly one summary per conversation.
- **SC-008**: A takeover reaches the widget within one SSE push; zero agent replies while paused.
- **SC-009**: Every broker-facing string is pt-BR; no emoji.
- **SC-010**: The panel is keyboard-operable with focus return; no horizontal scroll at 390 px.

## Clarifications

- **Metric period?** → Cumulative, no window.
- **Search over?** → Name, phone, e-mail, preview line; case-insensitive. Not the transcript.
- **Does assuming assign?** → Only an unassigned lead. Reassignment stays a manager action.
- **Summariser failure?** → Turns cleared, summary kept, failure logged; the next lead message retries.
- **Aguardando corretor?** → `status='paused'` and `heldByUserId` null, any stage.
- **Why a toggle, not a role scope?** → One agency query for both roles; the toggle is a default, not a permission.

## Assumptions

- 002, 003 and 004 are merged; see the verdict table for what they actually provide.
- The event catalog (`modelo-de-dados.md` §4) is closed; nothing is invented.
- 006's tiles read zero until 006 lands.
- Defaults: debounce 20 s, 25 rows per page.
- Decisions 6 and 7 block FR-001, FR-004 and FR-005 only. The dashboard, panel, handoff and summary read columns and do not wait on them.

## Out of Scope

Agent behaviour (004). Appointments, agenda, follow-up and its trigger button (006).
Charts, notifications, editing, bulk actions, export, CRM, a second channel.
