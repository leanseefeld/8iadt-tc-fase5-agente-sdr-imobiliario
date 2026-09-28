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
type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
type WeekdayAvailability = { enabled: boolean; start: string; end: string };
// users.availability's shape — read by loadBrokerAvailability, written whole by
// saveBrokerAvailability (FR-008a), seeded Mon–Fri 09:00–18:00 (§1 of
// modelo-de-dados.md; not a new column, just its read/write shape here).

type ProposeResult =
  | { ok: true; appointmentId: string; options: Option[] }
  | { ok: false; reason: 'no_brokers' | 'no_slots' };

type BookResult =
  | { ok: true; appointmentId: string; scheduledAt: Date; type: 'viewing' | 'call'; propertyCode?: string }
  | { ok: false; reason: 'collision' | 'too_soon' | 'unavailable' | 'no_proposal' };
// 'too_soon' — inside SCHEDULING_MIN_NOTICE_MINUTES; 'unavailable' — the broker's
// own users.availability does not enable that weekday or hour (replaces the
// fixed 'outside_window'/'weekend' pair, since availability is per broker now).

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

`conversations.followupState`: `{none | exhausted} → pending → {none | exhausted}`.
It moves to `pending` with the first enqueued attempt (FR-009) — including from
`exhausted`, when a returned conversation restarts the clock (FR-009a) — back to
`none` on any inbound lead reply regardless of how many attempts fired (FR-010,
`followupAttempts` resets with it), and to `exhausted` only when the last attempt
at the configured maximum sends unanswered (FR-016) — never set directly by a
booking or an appointment closure.

## 4 · Added 2026-09-28

- **`agencies.followupEnabled`** — `boolean not null default true`. One agency-wide switch set by a sales manager
  (FR-019), read at send time, never at enqueue. Lands in the same migration as §1's indexes.
- **Replacing a proposal** is cancel-then-insert: the open `proposed` row goes to `cancelled` through the same
  transition function as every other status change, and the new proposal is a new row. No unique index is needed;
  "at most one open proposal per conversation" is kept by that function.
- **Visita marcada** is derived: the lead has an appointment with `status = 'confirmed'` and `scheduledAt` in the
  future (FR-008b). `leads.status` keeps moving forward only (ADR 19).
