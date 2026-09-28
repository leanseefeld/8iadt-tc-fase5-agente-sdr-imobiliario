# Contracts: Scheduling and Follow-up

Four surfaces: the pure domain functions, the two agent tools, the worker
consumer's shape, and the configuration this slice adds or changes.

## 1 · Domain rules — `src/domain/scheduling.ts`

```ts
type Interval = { start: Date; end: Date };
type Option = { scheduledAt: Date; type: 'viewing' | 'call' };
type WindowRules = { windowStart: string; windowEnd: string; timezone: string };
type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
type WeekdayAvailability = { enabled: boolean; start: string; end: string };
type SlotRules = {
  availability: Record<Weekday, WeekdayAvailability>; // users.availability, this broker's
  minNoticeMinutes: number;   // SCHEDULING_MIN_NOTICE_MINUTES
  preferredTimes: string[];   // SCHEDULING_PREFERRED_TIMES, in order
  timezone: string;           // FOLLOWUP_TIMEZONE, read as the agency's operating tz
};

proposeSlots(busy: Interval[], now: Date, rules: SlotRules): Option[];
// Ten business days forward from `now`, in `rules.timezone`, testing
// `rules.preferredTimes` in order, skipping any day/hour `rules.availability`
// does not enable, skipping any hour inside a busy interval, skipping anything
// sooner than `rules.minNoticeMinutes`. Stops at three. Returns fewer than
// three, or [], per FR-001/FR-002 — never throws.

nextBrokerInRotation(brokerIds: string[], assignmentCounts: Record<string, number>): string;
// Minimum count wins; ties broken by position in `brokerIds`. The caller
// pre-filters `brokerIds` to those whose `specializations` include the lead's
// intent, falling back to every broker when that filter is empty (FR-003).
// Throws only if `brokerIds` itself is empty — the caller (FR-001's "no
// brokers" edge) checks first.

isWithinWindow(instant: Date, rules: WindowRules): boolean;
nextWindowOpening(instant: Date, rules: WindowRules): Date;
```

No import beyond the appointment/slot types. No I/O, no implicit clock — every
function takes the instant and the rules it reasons about as arguments, which is
what makes SC-002's 200 generated cases meaningful with no database.

## 2 · Services

```ts
// services/scheduling.ts
loadBusyIntervals(brokerId: string): Promise<Interval[]>;               // confirmed only
loadBrokerAvailability(brokerId: string): Promise<Record<Weekday, WeekdayAvailability>>;
saveBrokerAvailability(userId: string, rows: Record<Weekday, WeekdayAvailability>): Promise<void>;
proposeAppointment(input: { leadId; conversationId; agencyId; intent; propertyId?: string }): Promise<ProposeResult>;
// `type` is derived, not passed: 'call' with no property when `intent === 'investment'`
// (FR-003a), 'viewing' otherwise when a property is in play, 'call' if not.
bookAppointment(input: { conversationId; choice: { optionIndex: number } | { scheduledAt: Date } }): Promise<BookResult>;
listAppointments(scope, range: { from: Date; to: Date }): Promise<AgendaGroup[]>;
markAppointmentStatus(scope, appointmentId, status: 'done' | 'cancelled'): Promise<Result>;
// 'done' also sets the lead's pipeline stage 'visited'; both emit their event
// with actorType: 'user' and the acting actorUserId (FR-008).

// services/followup.ts
scheduleFollowup(tx, conversationId: string, now: Date): Promise<void>;
// Upsert keyed by conversation, sets conversations.followupState = 'pending';
// guarded (paused/closed, opted-out, a confirmed future appointment, nothing
// pending) in the same statement's `where` (FR-009).
cancelFollowup(tx, conversationId: string): Promise<{ recovered: boolean }>;
// Cancels every pending row, resets followupAttempts to 0 and followupState to
// 'none'; `recovered: true` when one row had already been sent (FR-010).
triggerNow(scope, leadId: string): Promise<Result>;                       // Result = { ok: true } | { ok: false; message }
```

`ProposeResult` and `BookResult` are defined in [data-model.md](data-model.md) §2.
`Result` follows spec 005's shape exactly: `{ ok: true } | { ok: false; message: string }`,
a pt-BR message the caller renders — failure (no proposal to book, nothing pending
to trigger) is an expected outcome, not an exception.

**Contract on the turn** (spec 007's `run()` and 004's `commitTurn`): at the point in the turn where the conversation is left
waiting on the lead, the orchestrator calls `scheduleFollowup`; on any inbound
lead message, before generating a reply, it calls `cancelFollowup`; on a broker
returning a held conversation to the agent (`heldByUserId` cleared) with
something still open, it calls `scheduleFollowup` again — the clock restart of
FR-009a. All three run inside `commitTurn`'s own transaction — this slice does not
open one.

## 3 · Proposing in code, booking by tool *(revised 2026-09-28)*

Proposing is **not** a tool. `run()` calls the service directly:

```ts
// services/scheduling.ts
computeOptions(ctx: { agencyId: string; leadId: string; intent: Intent; propertyId?: string;
  constraint?: { weekday?: Weekday; period?: 'morning' | 'afternoon' } }):
  Promise<{ brokerId: string; options: Option[] } | { unavailable: true; reason: string }>;   // writes nothing
recordProposal(ctx: { conversationId: string; leadId: string }, computed: { brokerId: string; options: Option[] }):
  Promise<{ appointmentId: string; options: Option[] }>;   // cancels the open proposed row, inserts the new one
proposeAppointment(ctx): Promise<{ appointmentId: string; options: Option[] } | { unavailable: true; reason: string }>;
declineProposal(conversationId: string): Promise<void>;   // proposed → cancelled
// No broker name is returned towards the agent (FR-005e); brokerId stays inside the service and the row.
```

`unavailable` covers FR-001's "no free hour" and "no brokers" edges, and a constraint nothing satisfies.

Booking is the **one** tool, added to 007's `actionTools()`:

```ts
bookMeeting(input: { optionIndex: number } | { scheduledAt: string }): Promise<
  | { confirmed: true; appointmentId: string; scheduledAt: string; type: 'viewing' | 'call'; propertyCode?: string }
  | { ok: false; reason: string; message: string }   // 007's ToolRefusal shape
>;
```

Its description states when to call — the lead picked an offered option or named a time while a proposal is
open — and when not to: no open proposal, or the lead is talking about something else. It re-validates through
the same function `proposeAppointment` uses.

The extraction gains two facts, beside `askedForHuman` and `optOut`:

```ts
declinedOffer: boolean;                 // "agora não", "prefiro não marcar"
askedForTimes: boolean;
pickedTime: boolean;                    // the lead picked an offered option or named a time — gates bookMeeting (FR-005f)                 // "tem outro horário?", "só de manhã", and after a decline "quero marcar uma visita"
timePreference?: { weekday?: Weekday; period?: 'morning' | 'afternoon' };
```

The options sentence and the confirmation are code-written (`prompts/meeting.ts`) and said verbatim; the
tool returns data, never wording.

## 4 · Worker consumer — `src/jobs/followup.ts`

```ts
// src/jobs/consumers.ts (created by whichever of 004/005/006 lands first)
type SweepConsumer = { name: string; run(ctx: { db: Database; now: Date; log: Logger }): Promise<void> };

// src/jobs/followup.ts
const followupConsumer: SweepConsumer = { name: 'followup', run: sweepFollowups };
```

`sweepFollowups` claims up to `FOLLOWUP_BATCH_SIZE` pending rows with `FOR UPDATE
SKIP LOCKED`, re-checks eligibility per row (FR-012, including "no confirmed
future appointment"), and logs one structured line per outcome (`sent`,
`rescheduled`, `cancelled`, `failed`) — the "reporting what it did" FR-011
requires. Two replicas running this consumer concurrently process each due row
exactly once (SC-005), by construction of `SKIP LOCKED` rather than any
application-level lock.

A `sent` outcome delivers through `ChannelAdapter.send` and the `Notifier` — the
same SSE path any other agent message uses, never a polling read (FR-015) — and
emits `followup.sent` with `actorType: 'worker'`, `actorUserId: null`, and the
writer call's Langfuse `traceId` (trace name `followup.send`, session id = the
conversation id). The next attempt is scheduled at `FOLLOWUP_BACKOFF_FACTOR`
times the previous interval; at the configured maximum, `followupState` becomes
`exhausted` instead (FR-016).

## 5 · Configuration

| Key | Default | Demo value | Read by |
|---|---|---|---|
| `FOLLOWUP_FIRST_DELAY_MINUTES` | `240` | `5` | `services/followup.ts` — **replaces** `FOLLOWUP_FIRST_DELAY_HOURS` |
| `FOLLOWUP_BATCH_SIZE` | `20` | `20` | `jobs/followup.ts` |
| `FOLLOWUP_BACKOFF_FACTOR` | `3` | `3` | `jobs/followup.ts` — **replaces** the hard-coded ×3 |
| `SCHEDULING_MIN_NOTICE_MINUTES` | `120` | unchanged | `services/scheduling.ts` — **replaces** the fixed 24-hour rule |
| `SCHEDULING_PREFERRED_TIMES` | `10:00,14:00,16:30` | unchanged | `services/scheduling.ts` — **replaces** the fixed 10:00/14:00/16:30 list |
| `FOLLOWUP_WINDOW_START` / `_END` / `_TIMEZONE` / `_MAX_ATTEMPTS` | unchanged | unchanged | already in `core/config.ts` (001) |
| `WORKER_SWEEP_INTERVAL_MS` | `900000` | `15000` | already in `core/config.ts` (001) — demo value only, not a new key |

`users.availability` is per-broker state, not agency configuration — it has no
env var and no default in `.env.example`; it is seeded Mon–Fri 09:00–18:00 and
edited on the agenda (FR-008a).

`FOLLOWUP_FIRST_DELAY_MINUTES`, `FOLLOWUP_BATCH_SIZE`, `FOLLOWUP_BACKOFF_FACTOR`,
`SCHEDULING_MIN_NOTICE_MINUTES` and `SCHEDULING_PREFERRED_TIMES` land in
`core/config.ts` and `.env.example` in the same commit — the Environment Contract
gate. The demo column is documentation in [quickstart.md](quickstart.md), not a
second set of defaults in `.env.example`.

## 6 · The agency's follow-up switch *(added 2026-09-28)*

```ts
// services/followup.ts
setFollowupEnabled(scope: SessionScope, enabled: boolean): Promise<Result>;   // salesManager only
```

Read by the worker in both eligibility checks (FR-012, FR-019). Never read when enqueuing.
