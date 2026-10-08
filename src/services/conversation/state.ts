import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../../db/client.ts";
import { properties } from "../../db/schema.ts";
import type { Intent } from "../../domain/slots.ts";
import type { LoadedTurn, PropertyRef, SchedulingRecord } from "./types.ts";

/**
 * What the conversation's own history says — the pending state a reply left on
 * its metadata (ADR 22), read back by the next turn. No writes.
 */

/** FR-017 — an offer to meet is already outstanding. No query of its own. */
export function offerOutstanding(turn: LoadedTurn): boolean {
  if (turn.appointmentProposed) return true;
  // The offer stays outstanding for the rest of the loaded history, not only
  // for the single turn after it. The last agent message is often an unrelated
  // reply; the offer is whichever earlier message recorded one.
  return turn.history.some((message) => {
    if (message.role !== "agent") return false;
    return message.metadata.meeting === "viewing" || message.metadata.meeting === "call";
  });
}

/** FR-009 — the previous agent turn was a reconfirmation. No query of its own. */
/**
 * FR-033 — how many properties the most recent search matched, or `null` when
 * there was none. Read from the last agent message that recorded a
 * `searchProperties` call, so a later turn can answer "nenhum imóvel?" without
 * searching again. A search made under another intent does not describe this one,
 * so an intent that never searches (`investment`, `undefined`) gets `null`.
 */
export function lastSearchOutcome(
  turn: LoadedTurn,
  intent: Intent = turn.lead.intent,
): { count: number } | null {
  if (intent !== "purchase" && intent !== "rental") return null;
  const last = [...turn.history].reverse().find(
    (message) =>
      message.role === "agent" &&
      Array.isArray(message.metadata.toolCalls) &&
      (message.metadata.toolCalls as { name?: unknown }[]).some(
        (call) => call.name === "searchProperties",
      ),
  );
  if (last === undefined) return null;
  const ids = last.metadata.propertyIds;
  return { count: Array.isArray(ids) ? ids.length : 0 };
}

/** FR-005: the times the latest options message offered, in the order the lead saw them. */
export function lastOfferedOptions(turn: LoadedTurn): Date[] {
  const carrier = [...turn.history]
    .reverse()
    .find((message) => message.role === "agent" && Array.isArray(message.metadata.meetingOptions));
  if (carrier === undefined) return [];
  return (carrier.metadata.meetingOptions as unknown[])
    .filter((value): value is string => typeof value === "string")
    .map((value) => new Date(value));
}

/** The kind of meeting the latest options message offered, if one did. */
export function lastOfferedType(turn: LoadedTurn): "viewing" | "call" | null {
  const carrier = [...turn.history]
    .reverse()
    .find((message) => message.role === "agent" && Array.isArray(message.metadata.meetingOptions));
  const kind = carrier?.metadata.meeting;
  return kind === "viewing" || kind === "call" ? kind : null;
}

/**
 * Spec 009: what the **last** agent reply left pending — a cancel to confirm, a
 * choice between meetings, a rebook offer. Only the reply just before counts:
 * a lead who talks about something else has moved on, and nothing is carried
 * over from further back.
 */
/** What the last reply left waiting for the lead's answer. */
export type PendingChange = Pick<SchedulingRecord, "pendingCancel" | "pendingChoice" | "rebook" | "closing" | "humanOffer">;

export function pendingChange(turn: LoadedTurn): PendingChange {
  const last = [...turn.history].reverse().find((message) => message.role === "agent");
  const metadata = last?.metadata ?? {};
  const choice = metadata.pendingChoice as { change?: unknown; ids?: unknown } | undefined;
  const rebook = metadata.rebook as SchedulingRecord["rebook"] | undefined;
  const offer = metadata.humanOffer as { about?: unknown } | undefined;
  return {
    ...(typeof metadata.pendingCancel === "string" ? { pendingCancel: metadata.pendingCancel } : {}),
    ...(choice !== undefined &&
    (choice.change === "cancel" || choice.change === "reschedule") &&
    Array.isArray(choice.ids)
      ? { pendingChoice: { change: choice.change, ids: choice.ids.filter((id): id is string => typeof id === "string") } }
      : {}),
    ...(rebook !== undefined && (rebook.type === "viewing" || rebook.type === "call") ? { rebook } : {}),
    ...(metadata.closing === true ? { closing: true as const } : {}),
    ...(offer !== undefined && typeof offer.about === "string" ? { humanOffer: { about: offer.about } } : {}),
  };
}

/** Spec 009: the appointment the latest options move, when they were offered for a reschedule. */
export function lastReschedulingId(turn: LoadedTurn): string | null {
  const carrier = [...turn.history]
    .reverse()
    .find((message) => message.role === "agent" && Array.isArray(message.metadata.meetingOptions));
  const id = carrier?.metadata.reschedulingId;
  return typeof id === "string" ? id : null;
}

/** FR-004b: the most recent property the lead pointed at, if any. */
export function latestInterestedProperty(turn: LoadedTurn): { id: string; code: string } | null {
  const carrier = [...turn.history]
    .reverse()
    .find((message) => message.role === "agent" && typeof message.metadata.interestedProperty === "object");
  const value = carrier?.metadata.interestedProperty as { id?: unknown; code?: unknown } | undefined;
  return typeof value?.id === "string" && typeof value.code === "string" ? { id: value.id, code: value.code } : null;
}


/**
 * FR-004b: resolve "o segundo" or "VMA-0005" to a property — **only** among the
 * properties already shown in this conversation, never the catalog at large.
 * A position counts in the latest set of cards; a code may be any card shown so
 * far. Anything else is `null`: ignored, never guessed.
 */
export async function resolvePropertyRef(
  turn: LoadedTurn,
  ref: PropertyRef,
): Promise<{ id: string; code: string } | null> {
  const withCards = turn.history.filter(
    (message) => message.role === "agent" && Array.isArray(message.metadata.propertyIds),
  );
  const shown = withCards.flatMap((message) => message.metadata.propertyIds as string[]);
  if (shown.length === 0) return null;

  const db = getDb();
  if ("position" in ref) {
    const latest = withCards.at(-1)?.metadata.propertyIds as string[];
    const id = latest[ref.position - 1];
    if (id === undefined) return null;
    const [row] = await db.select({ id: properties.id, code: properties.code }).from(properties).where(eq(properties.id, id));
    return row ?? null;
  }
  const [row] = await db
    .select({ id: properties.id, code: properties.code })
    .from(properties)
    .where(
      and(
        eq(properties.agencyId, turn.agency.id),
        sql`upper(${properties.code}) = ${ref.code.toUpperCase()}`,
        inArray(properties.id, shown),
      ),
    );
  return row ?? null;
}

export function lastTurnWasReconfirmation(turn: LoadedTurn): boolean {
  const lastAgent = [...turn.history].reverse().find((message) => message.role === "agent");
  return lastAgent?.metadata.reconfirmation === true;
}
