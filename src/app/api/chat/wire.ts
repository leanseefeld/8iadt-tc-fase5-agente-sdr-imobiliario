import type { Property } from "@/services/properties";
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

/**
 * `contracts/chat-api.md` §5 — the fields a card renders, and no others. The
 * catalog row carries a description, features and a condo fee the widget has no
 * use for, and the projection is what keeps them off a public wire.
 *
 * The price stays an integer in BRL: formatting to `R$ 680.000` is the
 * component's job, so a card the broker's `/catalogo` renders and a card the
 * lead sees cannot drift apart in a locale argument.
 */
export interface WireProperty {
  id: string;
  code: string;
  title: string;
  imageUrl: string;
  price: number;
  bedrooms: number;
  areaM2: number;
  neighborhood: string;
  city: string;
  transaction: "sale" | "rent";
}

export function toWireProperty(property: Property): WireProperty {
  return {
    id: property.id,
    code: property.code,
    title: property.title,
    imageUrl: property.imageUrl,
    price: property.price,
    bedrooms: property.bedrooms,
    areaM2: property.areaM2,
    neighborhood: property.neighborhood,
    city: property.city,
    transaction: property.transaction,
  };
}
