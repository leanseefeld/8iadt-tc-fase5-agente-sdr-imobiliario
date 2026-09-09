/**
 * The channel boundary — `contracts/chat-api.md` §1, shape for shape.
 *
 * This is the architecture claim of FR-015: a second channel (Telegram, a
 * WhatsApp gateway) is an implementation of `ChannelAdapter` and nothing else.
 * The HTTP surface in `src/app/api/chat/` is the *web* adapter's transport, not
 * the interface — Telegram would arrive on a webhook and never touch it.
 *
 * Delivery is deliberately not `send`'s job. `services/conversation.commitTurn`
 * writes the agent message and ends its transaction with `NOTIFY`
 * (`visao-geral.md` §8); the live widget is reached by the SSE stream, which is
 * a separate connection with its own lifetime. So `send` returns
 * `Promise<void>`: it persists and rings the doorbell, and there is no stream to
 * hand back. That is what lets spec 006's worker send a follow-up through the
 * same method, hours later, with no request in flight.
 */

export type Channel = "web" | "telegram";

/** One lead message, normalised out of whatever the channel's transport sent. */
export interface InboundMessage {
  channel: Channel;
  /** Resolves the tenant — every query in the turn is scoped by it (ADR 10). */
  agencySlug: string;
  /** The lead's identity on the channel; for the web widget, its session id. */
  externalId: string;
  /** Client-generated; the idempotency key of FR-035. */
  clientMessageId: string;
  text: string;
  receivedAt: Date;
  /** Sent once, on the message where the lead taps "Aceito" (FR-018). */
  consent?: boolean;
}

/** One message leaving towards the lead, whoever produced it. */
export interface OutboundMessage {
  conversationId: string;
  text: string;
  /** Cards to render, in order (FR-021/026). */
  propertyIds?: string[];
  /** The conversation was handed to a broker this turn (FR-028). */
  paused?: boolean;
}

export interface ChannelAdapter {
  /** Normalise the transport's payload, or throw `InboundMessageError`. */
  receive(raw: unknown): InboundMessage;
  /** Persist and notify. Delivery is the stream's job, not this one's. */
  send(message: OutboundMessage): Promise<void>;
}

/**
 * A malformed payload, with the field that was wrong. Thrown by `receive` and
 * turned into the `400` of `contracts/chat-api.md` §2 by the route handler —
 * the adapter does not know about status codes.
 */
export class InboundMessageError extends Error {
  constructor(readonly field: string) {
    super(`invalid inbound message: ${field}`);
    this.name = "InboundMessageError";
  }
}
