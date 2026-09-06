# Data Model: Scheduling and Follow-up

No new table. `appointments`, `followup_jobs`, `events` and their columns are
defined in [`modelo-de-dados.md`](../../docs/arquitetura/modelo-de-dados.md) §1 and
are not repeated here. This document adds only what that shared doc cannot know in
advance: the two indexes this slice's queries need, and the read shapes its
services return.

## 1 · Migration — indexes only

| Index | On | Why |
|---|---|---|
| `followup_jobs_claim_idx` | `followup_jobs (status, "scheduledFor")` where `status = 'pending'` | The worker's claim query filters on both and orders by `scheduledFor`; a partial index skips every `sent`/`cancelled`/`failed` row instead of scanning them. |
| `appointments_broker_busy_idx` | `appointments ("brokerId", "scheduledAt")` where `status = 'confirmed'` | `loadBusyIntervals(brokerId)` and the booking collision check both filter confirmed appointments by broker and time; proposed/cancelled/done rows never need this path. |

Both are partial indexes for the same reason spec 005's were: the table holds rows
in every terminal state, and the hot query only ever wants the pending or
confirmed subset.

## 2 · Read shapes

```ts
// domain/scheduling.ts
type Interval = { start: Date; end: Date };
type Option = { scheduledAt: Date; type: 'viewing' | 'call' };

// services/scheduling.ts
type ProposeResult =
  | { ok: true; appointmentId: string; options: Option[] }
  | { ok: false; reason: 'no_brokers' | 'no_slots' };

type BookResult =
  | { ok: true; appointmentId: string; scheduledAt: Date; type: 'viewing' | 'call'; propertyCode?: string }
  | { ok: false; reason: 'collision' | 'outside_window' | 'too_soon' | 'weekend' | 'no_proposal' };

// services/scheduling.ts — agenda read
type AgendaGroup = { label: 'Hoje' | 'Amanhã' | string; date: string; rows: AgendaRow[] };
type AgendaRow = {
  appointmentId: string; scheduledAt: Date; leadName: string;
  type: 'viewing' | 'call'; propertyCode?: string; neighborhood?: string;
  status: 'confirmed' | 'done' | 'cancelled';
};
```

`AgendaRow` never carries a `proposed` status — FR-007 excludes proposals from the
list, so the query's `where` already drops them; the type does not need a branch
for a state it will never see.

## 3 · State shapes already fixed by the spec

`appointments.status`: `proposed → confirmed → {done | cancelled}`, one row per
proposal-then-booking (Clarifications, Q1). `followup_jobs.status`: `pending →
{running → {sent | cancelled | pending} | failed}` — `running` always resolves back
to one of the other four within the same sweep; a row is never left `running`
across sweeps because the claim and the send happen in the same worker pass.
