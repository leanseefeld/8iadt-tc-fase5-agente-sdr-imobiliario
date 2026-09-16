# Data Model: Conversation

This slice defines **no tables**. The schema is
[`docs/arquitetura/modelo-de-dados.md`](../../docs/arquitetura/modelo-de-dados.md),
materialised by spec 002. What follows is only what 004 adds on top of it: the
in-memory shapes, the columns it writes, and the one index it creates.

## 1. Columns this slice writes

| Table | Written | When |
|---|---|---|
| `leads` | `name`, `phone`, `email`, `intent`, `status`, `score`, `consentAt`, `doNotContact` | Every turn; contact fields only after `consentAt` |
| `conversations` | `slots`, `status`, `fallbackStreak`, `lastLeadMessageAt`, `lastAgentMessageAt` | Every turn |
| `messages` | `role`, `content`, `metadata` | Two rows per turn: the lead's and the agent's |
| `events` | `type`, `payload`, `actorType`, `actorUserId`, `traceId` | Per the catalog below |
| `properties` | — read only | `searchProperties` |

`messages.metadata` carries, additively to the shapes already listed in the data
model: `clientMessageId` (string, lead messages), `propertyIds` (string[], agent
messages that showed cards), `toolCalls` (name + masked arguments), `guard` (which
reply guard fired, when one did).

## 2. Slot state

The Zod schema in `src/domain/slots.ts` is the code form of §2 of the data model.
Nothing else may define it, and the tool schema for `updateSlots` is derived from it
rather than written twice.

```
priceMax          number  | null   BRL
bedrooms          int     | null   minimum wanted
neighborhoods     string[]         [] is a valid answer: "open to suggestions"
urgency           'immediate' | 'soon' | 'exploring' | null
investorProfile   'firstTime' | 'experienced' | null
ticket            number  | null   BRL
returnExpectation 'income' | 'appreciation' | 'both' | 'undecided' | null
name              string  | null   consent-gated
contact           string  | null   consent-gated, phone or e-mail
```

`intent` lives on the lead, not in the slots, and is the first logical slot.

**Script order** (data model §2): `purchase` and `rental` →
`priceMax → bedrooms → neighborhoods → urgency → name → contact`; `investment` →
`investorProfile → ticket → returnExpectation → name → contact`; `undefined` → the
intent question and nothing else.

**Merge rules**, enforced in `mergeSlots` after every extraction:

1. A filled slot is never replaced by `null` or `undefined`.
2. `neighborhoods` set to `[]` is a filled slot, not an empty one.
3. `intent` only moves from `undefined` to a value, never between values.
4. A value failing the schema is dropped; the rest of the extraction still applies.
5. `name` and `contact` are dropped entirely while `consentAt` is null.

## 3. Derived, never stored

| Value | Function | Source |
|---|---|---|
| next question | `nextQuestion(intent, slots, consented)` | script order, first empty slot |
| score 0–100 | `scoreLead(intent, slots)` | data model §3 weights |
| temperature | `temperature(score)` | cold < 40 · warm 40–69 · hot ≥ 70 |
| `qualified` | all script slots except `name`/`contact` filled | data model §3 |
| handoff | `shouldHandoff(...)` → `asked` · `fallback` · none | ADR 19 |
| propose meeting | `shouldProposeMeeting(score, slots)` → hot with contact known; calls `proposeMeeting`, never pauses | ADR 19 |

## 4. Events emitted here

`lead.created` `{ channel }` · `lead.consented` `{}` · `intent.identified`
`{ intent }` · `slot.filled` `{ slot, value }` (value masked for `name`/`contact`) ·
`conversation.turn` `{ messageId }` · `properties.suggested` `{ propertyIds }` ·
`handoff.requested` `{ reason: asked · fallback }` · `lead.opted_out` `{}` ·
`lead.status_changed` `{ from, to }` for the agent-driven stages up to `scheduled`.
Every event written here carries `actorType: agent`, `actorUserId: null` and the
Langfuse `traceId` of the turn (data model §1, `events`).

`handoff.requested` is attributed to spec 005 in the data model's catalog; 004 owns
the three triggers, so it emits and 005 consumes. Recorded in
[plan.md](plan.md#boundary-notes-agreed-before-planning) rather than swapped
silently. `lead.qualified` stays with 005.

## 5. The one migration

```sql
create unique index messages_client_message_id_uniq
  on messages (conversation_id, (metadata ->> 'clientMessageId'))
  where metadata ? 'clientMessageId';
```

Idempotency (FR-035) as a constraint rather than a read-then-write race. No column,
no table — the shared data model is untouched.
