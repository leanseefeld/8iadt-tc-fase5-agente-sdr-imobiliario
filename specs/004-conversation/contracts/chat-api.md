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
  receive(raw: unknown): InboundMessage;                 // normalise, or throw
  send(message: OutboundMessage): Promise<Response>;     // web: the streamed response
}
```

`send` returns the transport's own result so the web adapter can stream. The worker
(spec 006) will call the same `send` and get back an appended agent message rather
than a stream — same interface, different implementation, which is the whole point.

## 2. POST /api/chat

Runs one turn and streams the reply. Request:

```json
{ "agencySlug": "imobiliaria-demo", "sessionId": "…", "clientMessageId": "…",
  "text": "Estou procurando apartamento na zona sul", "consent": false }
```

`consent: true` is sent once, on the turn where the lead accepts the banner.

**Response**: `200`, an AI SDK UI message stream. Alongside the text the stream
carries the turn's data parts: the property cards to render and the paused flag.
Nothing else the widget needs is fetched separately.

**Status codes**

| Code | When | Body |
|---|---|---|
| 200 | Turn ran, or the same `clientMessageId` was already answered — the stored reply is replayed | stream |
| 400 | Malformed body, missing `sessionId` or `clientMessageId` | `{ error }` |
| 404 | Unknown `agencySlug` | `{ error }` |
| 409 | Conversation is paused for a broker; no agent turn is produced | `{ error, paused: true }` |
| 429 | Per-session rate limit exceeded; nothing was persisted | `{ error }` with pt-BR copy |

A model failure is **not** an error code: the turn returns 200 with the generic
pt-BR fallback text, because a conversation that dies silently is worse than one
that apologises (FR-014).

## 3. GET /api/chat?agencySlug=…&sessionId=…

History for a session. Used on widget mount (L14 resume) and polled while paused.

```json
{ "conversationId": "…", "status": "active" | "paused" | "closed",
  "consented": true,
  "messages": [ { "id": "…", "role": "lead" | "agent" | "broker",
                  "content": "…", "propertyIds": ["…"], "createdAt": "…" } ] }
```

`404` for an unknown agency. An unknown session id is `200` with an empty message
list and `conversationId: null` — a first visit is not an error, and no lead row is
created by a read.

## 4. Property card payload

The fields a card renders, taken from the search result and never from model prose:

```
id · code · title · imageUrl · price (int, BRL) · bedrooms · areaM2 ·
neighborhood · city · transaction
```

Formatting to `R$ 680.000` happens in the component. At most three cards per turn.
