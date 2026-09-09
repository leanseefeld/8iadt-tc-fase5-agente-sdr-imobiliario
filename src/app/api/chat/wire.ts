import type { TurnMessage } from "@/services/conversation";

/**
 * The one shape a message takes on the wire — `contracts/chat-api.md` §3 and
 * §4's `message` event, which are deliberately the same object so the widget
 * has a single renderer for a bubble it loaded and a bubble it was pushed.
 *
 * `propertyIds` lives in the message's `metadata` in the database because the
 * cards are a property of that reply, not a column; it is lifted out here so
 * the client never learns what else metadata holds (tool calls, the guard that
 * fired) — none of which is a lead's business.
 */
export interface WireMessage {
  id: string;
  role: "lead" | "agent" | "broker";
  content: string;
  propertyIds?: string[];
  repliesToMessageId?: string;
  createdAt: string;
}

export function toWireMessage(message: TurnMessage): WireMessage {
  const propertyIds = message.metadata.propertyIds;

  return {
    id: message.id,
    // `system` messages never leave the server; every caller filters them out
    // before this point, and the cast is what says so.
    role: message.role as WireMessage["role"],
    content: message.content,
    ...(Array.isArray(propertyIds) && propertyIds.length > 0
      ? { propertyIds: propertyIds as string[] }
      : {}),
    ...(message.repliesToMessageId !== null
      ? { repliesToMessageId: message.repliesToMessageId }
      : {}),
    createdAt: message.createdAt.toISOString(),
  };
}
