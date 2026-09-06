# Contracts: Scheduling and Follow-up

Four surfaces: the pure domain functions, the two agent tools, the worker
consumer's shape, and the configuration this slice adds or changes.

## 1 · Domain rules — `src/domain/scheduling.ts`

```ts
type Interval = { start: Date; end: Date };
type Option = { scheduledAt: Date; type: 'viewing' | 'call' };
type WindowRules = { windowStart: string; windowEnd: string; timezone: string };

proposeSlots(busy: Interval[], now: Date, rules?: { timezone: string }): Option[];
// Ten business days forward from `now`, in `rules.timezone` (default agency tz),
// testing 10:00/14:00/16:30 in that order, skipping weekends, skipping any hour
// inside a busy interval, skipping anything sooner than 24h from `now`. Stops at
// three. Returns fewer than three, or [], per FR-001/FR-002 — never throws.

nextBrokerInRotation(brokerIds: string[], assignmentCounts: Record<string, number>): string;
// Minimum count wins; ties broken by position in `brokerIds`. Throws only if
// `brokerIds` is empty — the caller (FR-003's "no brokers") checks first.

isWithinWindow(instant: Date, rules: WindowRules): boolean;
nextWindowOpening(instant: Date, rules: WindowRules): Date;
```

No import beyond the appointment/slot types. No I/O, no implicit clock — every
function takes the instant it reasons about as an argument, which is what makes
SC-002's 200 generated cases meaningful with no database.

## 2 · Services

```ts
// services/scheduling.ts
loadBusyIntervals(brokerId: string): Promise<Interval[]>;               // confirmed only
proposeAppointment(input: { leadId; conversationId; agencyId; propertyId?: string; type }): Promise<ProposeResult>;
bookAppointment(input: { conversationId; choice: { optionIndex: number } | { scheduledAt: Date } }): Promise<BookResult>;
listAppointments(scope, range: { from: Date; to: Date }): Promise<AgendaGroup[]>;
markAppointmentStatus(scope, appointmentId, status: 'done' | 'cancelled'): Promise<Result>;

// services/followup.ts
scheduleFollowup(tx, conversationId: string, now: Date): Promise<void>;   // upsert, keyed by conversation
cancelFollowup(tx, conversationId: string): Promise<{ recovered: boolean }>;
triggerNow(scope, leadId: string): Promise<Result>;                       // Result = { ok: true } | { ok: false; message }
```

`ProposeResult` and `BookResult` are defined in [data-model.md](data-model.md) §2.
`Result` follows spec 005's shape exactly: `{ ok: true } | { ok: false; message: string }`,
a pt-BR message the caller renders — failure (no proposal to book, nothing pending
to trigger) is an expected outcome, not an exception.

**Contract on spec 004**: at the point in the turn where the conversation is left
waiting on the lead, the orchestrator calls `scheduleFollowup`; on any inbound
lead message, before generating a reply, it calls `cancelFollowup`. Both run inside
004's own turn transaction — this slice does not open one.

## 3 · Agent tools — `src/agent/tools/scheduling.ts`

Replaces `tools/scheduling.stub.ts`, registered in `tools/index.ts` with the
schemas 004 declares as placeholders:

```ts
proposeMeeting(): Promise<{ options: Option[] } | { unavailable: true; reason: string }>;
// No arguments — reads the active conversation from orchestrator context.
// `unavailable` covers FR-001's "no free hour" and "no brokers" edges; the
// orchestrator's prompt turns that into asking the lead for a time and raising
// a handoff, per the spec's edge case.

bookMeeting(input: { optionIndex: number } | { scheduledAt: string }): Promise<
  | { confirmed: true; scheduledAt: string; type: 'viewing' | 'call'; propertyCode?: string; weekday: string }
  | { confirmed: false; reason: string }
>;
```

Both tools return data; the confirmation card and any re-proposal wording render
in the orchestrator's commit step, never inside the tool — per constitution
principle V, the model does not decide the meeting time or the retry message.

## 4 · Worker consumer — `src/jobs/followup.ts`

```ts
// src/jobs/consumers.ts (created by whichever of 004/005/006 lands first)
type SweepConsumer = { name: string; run(ctx: { db: Database; now: Date; log: Logger }): Promise<void> };

// src/jobs/followup.ts
const followupConsumer: SweepConsumer = { name: 'followup', run: sweepFollowups };
```

`sweepFollowups` claims up to `FOLLOWUP_BATCH_SIZE` pending rows with `FOR UPDATE
SKIP LOCKED`, re-checks eligibility per row (FR-012), and logs one structured line
per outcome (`sent`, `rescheduled`, `cancelled`, `failed`) — the "reporting what it
did" FR-011 requires. Two replicas running this consumer concurrently process each
due row exactly once (SC-005), by construction of `SKIP LOCKED` rather than any
application-level lock.

## 5 · Configuration

| Key | Default | Demo value | Read by |
|---|---|---|---|
| `FOLLOWUP_FIRST_DELAY_MINUTES` | `240` | `1` | `services/followup.ts` — **replaces** `FOLLOWUP_FIRST_DELAY_HOURS` |
| `FOLLOWUP_BATCH_SIZE` | `20` | `20` | `jobs/followup.ts` |
| `FOLLOWUP_WINDOW_START` / `_END` / `_TIMEZONE` / `_MAX_ATTEMPTS` | unchanged | unchanged | already in `core/config.ts` (001) |
| `WORKER_SWEEP_INTERVAL_MS` | `900000` | `5000` | already in `core/config.ts` (001) — demo value only, not a new key |

`FOLLOWUP_FIRST_DELAY_MINUTES` and `FOLLOWUP_BATCH_SIZE` land in `core/config.ts`
and `.env.example` in the same commit — the Environment Contract gate. The demo
column is documentation in [quickstart.md](quickstart.md), not a second set of
defaults in `.env.example`.
