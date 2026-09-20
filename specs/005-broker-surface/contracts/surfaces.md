# Contracts: Broker Surface

Types are indicative; the compiler is the authority.

## 1 · Domain rules

This slice owns one: `domain/lead-status.ts` — `canTransition(from, to)` /
`assertTransition(from, to)` for the FR-007 stages a broker may set.

It *reads* `temperature(score)` from `domain/score.ts` to render a row. Scoring,
qualification, handoff and meeting rules belong to ADR 20's spec, not here.

## 2 · Services and Server Actions

Every function takes the `LeadScope` from `scopeForUser` first and applies
`agencyId` in SQL. No caller passes a raw `agencyId`.

```ts
// services/leads.ts
listLeads(scope, q: { filter: 'todos'|'ao_vivo'|'aguardando'|'visita_marcada'|'sem_resposta';
                      mine: boolean; userId: string; search?: string; page: number })
  : Promise<{ rows: LeadRow[]; total: number }>;
getLeadDetail(scope, leadId): Promise<LeadDetail | null>;   // null when out of scope

// services/metrics.ts
getFunnelMetrics(scope): Promise<FunnelMetrics>;   // qualification rate from leads.status

// services/handoff.ts
assumeConversation(scope, leadId, userId): Promise<Result>;
returnToAgent(scope, leadId, userId): Promise<Result>;
sendBrokerReply(scope, leadId, userId, text): Promise<Result>;  // requires userId to hold it
setLeadStatus(scope, leadId, userId, next): Promise<Result>;
```

`Result = { ok: true } | { ok: false; message: string }` (pt-BR). Reassignment
reuses `services/auth.reassignLead`, wrapped into `Result` by the action.

`app/(app)/leads/actions.ts`: read the session, build the scope, call the service,
`revalidatePath('/leads')`. Trust only the lead id and the text from the request.

## 2a · Real time

`Notifier` gains `subscribeAgency(agencyId, listener)` and the channel
`conversation_state` with payload `{ conversationId, agencyId, status }` — ids and
status only. Published after commit by `handoff.ts` and `jobs/summarize.ts`.

- `/api/leads/stream` (broker session): forwards `conversation_message` and
  `conversation_state` for the session's agency as `event: changed`,
  `data: { conversationId }`. 15 s pulse.
- `/api/chat/[conversationId]/events` (004): forwards `conversation_state` for its
  conversation as `event: status`, `data: { status }`.

## 3 · Summariser — `agent/summarizer.ts`

```ts
summarizeConversation(input: {
  previousSummary: string | null;
  messages: { role: 'lead'|'agent'|'broker'; content: string }[];
}): Promise<{ summary: string; previewLine: string }>;
```

Prompt (pt-BR): 2–4 sentences for a broker who has not read the conversation —
want, constraints, urgency, next step — plus one key sentence ≤ 90 characters in
the register of *"Contrato de aluguel vence em 6 semanas"*. No greeting, no emoji.
Code strips quotes and truncates `previewLine` at a word boundary ≤ 90.

Telemetry: `functionId: 'summary.generate'`, session id = `conversationId`,
`leadId` metadata, masked via `core/security.ts` and the name redaction registry.

## 4 · Configuration

| Key | Default | Read by |
|---|---|---|
| `SUMMARY_DEBOUNCE_SECONDS` | `20` | `jobs/summarize.ts` |
| `SUMMARY_BATCH_SIZE` | `10` | `jobs/summarize.ts` |
| `LEADS_PAGE_SIZE` | `25` | `services/leads.ts` |
| `DASHBOARD_LIVE_WINDOW_MINUTES` | `10` | row live dot, *Ao vivo* filter |

Trace links use the existing `LANGFUSE_UI_PORT`.
