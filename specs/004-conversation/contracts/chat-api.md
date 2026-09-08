# Chat surface contract

Two shapes: the `ChannelAdapter` interface, which is the architecture claim, and the
HTTP surface the web adapter happens to use. A second channel implements the first
and ignores the second.

## 1. ChannelAdapter

```ts
type Channel = 'web' | 'telegram';

interface InboundMessage {
  channel: Channel;
  agencySlug: string;      // resolves the tenant — every query is scoped by it
  externalId: string;      // the lead's identity on the channel; the widget session id
  clientMessageId: string; // client-generated; the idempotency key
  text: string;
  receivedAt: Date;
}

interface OutboundMessage {
  conversationId: string;
  text: string;
  propertyIds?: string[];  // cards to render, in order
  paused?: boolean;        // the conversation was handed to a broker this turn
}

interface ChannelAdapter {
  receive(raw: unknown): InboundMessage;              // normalise, or throw
  send(message: OutboundMessage): Promise<void>;      // persist + notify; see below
}
```

Delivery is no longer `send`'s job. `commitTurn` already writes the message and ends
its transaction with `NOTIFY` (`visao-geral.md` §8); the web adapter's `send` is a
thin wrapper around that, and the live widget is reached by the separate SSE stream
below, not by the return value of `send`. The worker (spec 006) calls the same
`send` for a follow-up message — same interface, same effect, no stream to return
either way, which is the whole point of moving delivery off the request/response
cycle.

## 2. POST /api/chat

Stores the lead message and returns — it does **not** run a turn inline. Request:

```json
{ "agencySlug": "imobiliaria-demo", "sessionId": "…", "clientMessageId": "…",
  "text": "Estou procurando apartamento na zona sul", "consent": false }
```

`consent: true` is sent once, on the message where the lead taps "Aceito".

**Status codes**

| Code | When | Body |
|---|---|---|
| 200 | Consent not yet recorded, or the session's `CHAT_MESSAGE_BUDGET` or `CHAT_MAX_MESSAGE_CHARS` was exceeded — a fixed pt-BR template reply, no model call, nothing persisted | `{ text }` |
| 202 | Lead message stored. A turn follows `CHAT_DEBOUNCE_MS` later if the conversation is `active`; a `paused` conversation stores the message and produces no agent turn | `{ conversationId }` |
| 400 | Malformed body — missing `sessionId` or `clientMessageId` | `{ error }` |
| 404 | Unknown `agencySlug` | `{ error }` |

A model failure is **not** an error code here either: the async turn simply
delivers the generic pt-BR fallback text over the SSE stream like any other reply,
because a conversation that dies silently is worse than one that apologises
(FR-014). Repeating a `clientMessageId` is a no-op — FR-035's unique index, not a
read-then-write race — and still answers `202`.

## 3. GET /api/chat?agencySlug=…&sessionId=…

History for a session. Used once, on widget mount (L14 resume); live updates come
from the SSE stream below, not from calling this again.

```json
{ "conversationId": "…", "status": "active" | "paused" | "closed",
  "consented": true,
  "messages": [ { "id": "…", "role": "lead" | "agent" | "broker",
                  "content": "…", "propertyIds": ["…"],
                  "repliesToMessageId": "…", "createdAt": "…" } ] }
```

`404` for an unknown agency. An unknown session id is `200` with an empty message
list and `conversationId: null` — a first visit is not an error, and no lead row is
created by a read.

## 4. GET /api/chat/[conversationId]/events

The SSE stream (`visao-geral.md` §8), authorised by the signed widget session — the
`conversationId` in the URL is not itself trusted, the session is. One connection,
kept open, replayable from `Last-Event-ID` on reconnect.

| Event | Payload | When |
|---|---|---|
| `chunk` | `{ text }` | Sentence-sized pieces of the reply as the guards clear them |
| `message` | `{ id, role, content, propertyIds?, repliesToMessageId?, createdAt }` | The turn's final, persisted agent (or broker) message |
| `pulse` | `{}` | Every `SSE_PULSE_INTERVAL_MS`, keep-alive |
| `goodbye` | `{}` | On `SIGTERM`, before the server closes the stream |

Two missed pulses and the widget shows "Conexão perdida. Reconectando…" and disables
the composer; `EventSource` reconnects on its own, and the server replays from
`Last-Event-ID` by re-reading the database — the notification is only a wake-up, the
row is the truth. A `message` event whose `repliesToMessageId` is not the lead's most
recent message means newer lead messages exist; the widget quotes the first line of
the message named by `repliesToMessageId` at the top of the bubble.

## 5. Property card payload

The fields a card renders, taken from the search result and never from model prose:

```
id · code · title · imageUrl · price (int, BRL) · bedrooms · areaM2 ·
neighborhood · city · transaction
```

Formatting to `R$ 680.000` happens in the component. At most three cards per turn.
