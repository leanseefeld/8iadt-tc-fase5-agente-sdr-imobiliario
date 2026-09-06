# Contracts: Broker Surface

Three surfaces: the rule functions, the service and action signatures, and the
summariser's structured output. Types are indicative; the compiler is the authority.

## 1 · Domain rules — `src/domain/scoring.ts`

```ts
type Temperature = 'cold' | 'warm' | 'hot';
type HandoffReason = 'asked' | 'fallback' | 'score';

scoreLead(intent: Intent, slots: Slots): number;          // 0..100, capped
temperatureOf(score: number): Temperature;                // <40 · 40–69 · >=70
isQualified(intent: Intent, slots: Slots): boolean;        // every script slot but name/contact
shouldHandoff(input: {
  intent: Intent; slots: Slots; score: number;
  fallbackStreak: number; leadAskedForHuman: boolean;
}): HandoffReason | null;
```

Weights, exactly as published in `modelo-de-dados.md` §3: intent identified 10; each
filled script slot other than `name`/`contact` 15 (purchase and rental have four,
investment three); `contact` filled 15; plus 15 when `urgency = 'immediate'` or
`returnExpectation ≠ 'undecided'` with `ticket >= 1_000_000`; plus 5 when
`urgency = 'soon'`. Capped at 100. `intent = 'undefined'` scores 0 and is never
qualified.

`shouldHandoff` returns, in priority order: `'asked'`, `'fallback'` when
`fallbackStreak >= 2`, `'score'` when hot and `contact` is filled, else `null`.

No import beyond the slot types. No I/O, no clock, no randomness — the same input
gives the same answer forever, which is what makes the table test meaningful.

## 2 · Services and Server Actions

Every function takes a `Scope` from `scopeForUser` (spec 003) as its first argument
and applies it in SQL. None accepts a raw `agencyId` from a caller.

```ts
// services/leads.ts
listLeads(scope, q: { filter: 'todos'|'quentes'|'aguardando'|'agendados';
                      search?: string; page: number }): Promise<{ rows: LeadRow[]; total: number }>;
getLeadDetail(scope, leadId): Promise<LeadDetail | null>;   // null when out of scope

// services/metrics.ts
getFunnelMetrics(scope): Promise<FunnelMetrics>;

// services/qualification.ts — called by spec 004, inside its turn transaction
recordTurnOutcome(tx, input: { leadId; conversationId; intent; slots;
  fallbackStreak: number; leadAskedForHuman: boolean }): Promise<{ score; qualified; handoff }>;

// services/handoff.ts
assumeConversation(scope, leadId, userId): Promise<Result>;   // fails if already paused
returnToAgent(scope, leadId, userId): Promise<Result>;
sendBrokerReply(scope, leadId, userId, text): Promise<Result>; // fails unless paused
setLeadStatus(scope, leadId, next): Promise<Result>;           // fails on an illegal transition
reassignLead(scope, leadId, brokerId): Promise<Result>;        // salesManager only
```

**Contract on spec 004**: while `conversations.status = 'paused'`, the orchestrator
must return without generating or sending anything for that conversation. This slice
owns the state and the events; 004 owns the check. Nothing else couples the two.

`Result` is `{ ok: true } | { ok: false; message: string }` — a pt-BR message the
panel renders. Failure is an expected outcome here (a colleague got there first), not
an exception.

The five Server Actions in `app/(app)/leads/actions.ts` are thin: read the session,
build the scope, call the service above, `revalidatePath('/leads')`, return `Result`.
They re-derive identity server-side and trust nothing from the request body but the
lead id and the text.

## 3 · Summariser output — `src/agent/summarizer.ts`

```ts
const summarySchema = z.object({
  summary: z.string().min(1),
  previewLine: z.string().min(1),
});
summarizeConversation(input: {
  previousSummary: string | null;
  messages: { role: 'lead'|'agent'|'broker'; content: string }[];
}): Promise<{ summary: string; previewLine: string }>;
```

Prompt contract, in pt-BR: two to four sentences written for a broker who has not
read the conversation — what the lead wants, the constraints, the urgency, the next
step — plus one key sentence for the list, of at most 90 characters, in the register
of *"Contrato de aluguel vence em 6 semanas"*. No greeting, no meta-commentary, no
emoji.

Enforced in code rather than trusted to the model: `previewLine` is trimmed of
quotes and truncated at the last word boundary at or under 90 characters. Sentence
count is a prompt instruction only — see the plan's amendment to FR-011.

Telemetry: the call carries `functionId: 'summarize'` with `conversationId` and
`leadId` metadata, and its input and output pass through `core/masking.ts` before
reaching a log or a trace.

## 4 · Configuration added

| Key | Default | Read by |
|---|---|---|
| `SUMMARY_DEBOUNCE_SECONDS` | `20` | `jobs/summarize.ts` |
| `SUMMARY_BATCH_SIZE` | `10` | `jobs/summarize.ts` |
| `LEADS_PAGE_SIZE` | `25` | `services/leads.ts` |

All three land in `core/config.ts` and `.env.example` in the same commit — the
Environment Contract gate, enforced by `tests/env-example.test.ts`.
