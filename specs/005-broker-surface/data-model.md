# Data Model: Broker Surface

Schema: `docs/arquitetura/modelo-de-dados.md`. No table or column added.

## Writes

| Column | Writer | Rule |
|---|---|---|
| `leads.status` | `setLeadStatus` | FR-007 transitions (agent stages are 004's) |
| `leads.assignedBrokerId` | assume (only when null), `reassignLead` | |
| `conversations.status`, `heldByUserId` | assume / return | `active ⇄ paused` |
| `conversations.summary`, `previewLine`, `summaryUpdatedAt` | `jobs/summarize.ts` | One statement |
| `messages` `role='broker'` | `sendBrokerReply` | `metadata.userId` |
| `events.processedAt` | `jobs/summarize.ts` | On consumed `conversation.turn` rows |

## Events appended

| type | payload | when |
|---|---|---|
| `conversation.assumed` / `conversation.returned` | `{ userId }` | Assume / return |
| `lead.status_changed` | `{ from, to }` | Broker changes stage |
| `summary.updated` | `{}` | Summary stored |

`handoff.requested`, agent-stage `lead.status_changed` (004) and `lead.reassigned`
(003) already exist. `lead.qualified` is **not** written here — it moves with the
scoring rules to ADR 20's spec, and the qualification tile reads `leads.status`.

## Indexes — migration 0002

```sql
create index events_pending_turns_idx on events (conversation_id, created_at)
  where type = 'conversation.turn' and processed_at is null;
create index leads_queue_idx on leads (agency_id, assigned_broker_id, score desc, updated_at desc);
```

## Derived, never stored

Temperature (`temperature(score)` — read, never computed here), *Aguardando
corretor* (`paused` with `heldByUserId` null).
