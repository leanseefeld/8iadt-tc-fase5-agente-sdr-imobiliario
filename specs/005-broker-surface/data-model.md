# Data Model: Broker Surface

The schema is `docs/arquitetura/modelo-de-dados.md`, materialised by spec 002. This
slice **creates no table and no column**. What follows is what it writes, what it
reads, and the two indexes it adds.

## Columns this slice writes

| Table.column | Written by | Rule |
|---|---|---|
| `leads.score` | `services/qualification.ts`, per turn | `scoreLead(intent, slots)`, 0–100 |
| `leads.status` | qualification, and the panel's status select | Only along the FR-006 transitions |
| `leads.assignedBrokerId` | takeover (when null) and manager reassignment | A takeover never overwrites a non-null value |
| `conversations.status` | takeover / return | `active ⇄ paused`; `paused` means a broker holds it |
| `conversations.summary` · `previewLine` · `summaryUpdatedAt` | `jobs/summarize.ts` | Written together, in one statement |
| `messages` (`role='broker'`) | broker reply | `metadata.userId` names the author |
| `events.processedAt` | `jobs/summarize.ts` | Set on the turn events a summary consumed |

## Events this slice appends

All five already exist in the catalog (§4); none is invented.

| type | payload | when |
|---|---|---|
| `lead.qualified` | `{ score }` | The first turn on which the lead becomes qualified |
| `handoff.requested` | `{ reason: 'asked' \| 'fallback' \| 'score' }` | The rule fires, or 004 reports the lead asked / two fallbacks |
| `conversation.assumed` | `{ userId }` | A broker takes over |
| `conversation.returned` | `{ userId }` | A broker hands back |
| `summary.updated` | `{}` | A summary is stored |

## Read models

Not tables — the shapes services return. Full field lists in
[`contracts/surfaces.md`](contracts/surfaces.md).

- **LeadRow** — one list row: id, temperature, name, intent, the compact
  qualification line, preview line, last lead message time, follow-up state, and
  whether it is *Aguardando corretor* (`leads.status='handoff'` with the
  conversation still `active`).
- **LeadDetail** — the panel: lead, conversation, full message list, event list.
- **FunnelMetrics** — four numbers: median first-response seconds, qualification
  rate, confirmed appointments, leads recovered. Any of them may legitimately be
  zero or null before spec 006 lands.

## Indexes added

One migration, two indexes, each because a query in this slice needs it.

```sql
create index events_pending_turns_idx on events (conversation_id, created_at)
  where type = 'conversation.turn' and processed_at is null;
create index leads_queue_idx on leads (agency_id, assigned_broker_id, score desc, updated_at desc);
```

The first keeps the summariser's select and claim off a sequential scan as the trail
grows; the second serves the list's scope and ordering (SC-003).

## Derived, never stored

- **Temperature** — `temperatureOf(score)`: cold below 40, warm 40–69, hot 70 and
  above. The data model says explicitly it is not a column.
- **Qualified** — every script slot but `name`/`contact` filled. `leads.status`
  records that it happened; the verdict itself is recomputed.
- **Aguardando corretor** — a pair of statuses, per the spec's clarification.
