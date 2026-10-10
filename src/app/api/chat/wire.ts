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
 *
 * `booking` is lifted the same way (spec 006 FR-006): the time, the kind and the
 * property code the confirmation card shows. The appointment id and the broker
 * stay behind — the lead was told "alguém da nossa equipe", or "nosso especialista
 * em investimentos", never a name (FR-005e).
 */
export interface WireBooking {
  scheduledAt: string;
  type: "viewing" | "call";
  propertyCode: string | null;
}

export interface WireMessage {
  id: string;
  role: "lead" | "agent" | "broker";
  content: string;
  propertyIds?: string[];
  booking?: WireBooking;
  repliesToMessageId?: string;
  createdAt: string;
}

function readBooking(value: unknown): WireBooking | null {
  if (typeof value !== "object" || value === null) return null;
  const { scheduledAt, type, propertyCode } = value as Record<string, unknown>;
  if (typeof scheduledAt !== "string" || (type !== "viewing" && type !== "call")) return null;
  return { scheduledAt, type, propertyCode: typeof propertyCode === "string" ? propertyCode : null };
}

export function toWireMessage(message: TurnMessage): WireMessage {
  const propertyIds = message.metadata.propertyIds;
  const booking = readBooking(message.metadata.booking);

  return {
    id: message.id,
    // `system` messages never leave the server; every caller filters them out
    // before this point, and the cast is what says so.
    role: message.role as WireMessage["role"],
    content: message.content,
    ...(Array.isArray(propertyIds) && propertyIds.length > 0
      ? { propertyIds: propertyIds as string[] }
      : {}),
    ...(booking !== null ? { booking } : {}),
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
