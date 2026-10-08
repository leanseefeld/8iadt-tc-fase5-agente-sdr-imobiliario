import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/client.ts";
import { agencies, conversations, events as events_, leads, messages } from "../../db/schema.ts";
import { getConfig } from "../../core/config.ts";
import { cancelFollowup } from "../followup.ts";
import { maskPII } from "../../core/security.ts";
import type { Channel, ConversationStatus } from "./types.ts";
import { loadTurn } from "./load.ts";
import type { PendingEvent } from "./commit.ts";

/** A lead's message arriving: consent, budget and length, then stored (FR-032, FR-035). */

export interface InboundLeadMessage {
  agencySlug: string;
  channel?: Channel;
  /** The lead's identity on the channel — the widget's session id. */
  externalId: string;
  /** Client-generated; the idempotency key of FR-035. */
  clientMessageId: string;
  text: string;
  /** Sent once, on the message where the lead taps "Aceito". */
  consent?: boolean;
  receivedAt?: Date;
}

export type InboundRejection = "consent" | "budget" | "tooLong";

export type InboundResult =
  | { status: "unknownAgency" }
  | { status: "rejected"; reason: InboundRejection }
  /** `duplicate` means the same `clientMessageId` arrived before — nothing was written. */
  | {
      status: "stored" | "duplicate" | "consented";
      agencyId: string;
      leadId: string;
      conversationId: string;
      conversationStatus: ConversationStatus;
      messageId: string | null;
      consented: boolean;
    };

/**
 * Stores one inbound lead message, creating the lead and the conversation on
 * first contact — which is why opening the widget and leaving creates nothing.
 *
 * Three things are refused before anything is written, each costing no model
 * call and persisting no turn (FR-019, FR-032): a message longer than
 * `CHAT_MAX_MESSAGE_CHARS`, a message sent before consent is recorded, and a
 * session over `CHAT_MESSAGE_BUDGET` inside its window. The caller answers each
 * with the fixed pt-BR template of `contracts/chat-api.md` §2.
 *
 * Idempotency is the unique index of `data-model.md` §5, not a read-then-write
 * check: the second arrival of a `clientMessageId` conflicts, inserts nothing and
 * is reported as `duplicate`, so no second lead message and no second turn
 * (FR-035). `on conflict do nothing` rather than catch-and-continue, because a
 * raised unique violation aborts the whole transaction in Postgres and would
 * take the lead and the conversation created above down with it.
 */
export async function recordLeadMessage(inbound: InboundLeadMessage): Promise<InboundResult> {
  const db = getDb();
  const config = getConfig();
  const channel = inbound.channel ?? "web";
  const now = inbound.receivedAt ?? new Date();
  const text = inbound.text.trim();

  if (text.length > config.CHAT_MAX_MESSAGE_CHARS) return { status: "rejected", reason: "tooLong" };

  const [agency] = await db
    .select({ id: agencies.id })
    .from(agencies)
    .where(eq(agencies.slug, inbound.agencySlug))
    .limit(1);
  if (agency === undefined) return { status: "unknownAgency" };

  const existing = await loadTurn({ agencySlug: inbound.agencySlug, externalId: inbound.externalId, channel });
  const consented = existing?.lead.consentAt != null || inbound.consent === true;

  // Nothing at all is created for text typed before the "Aceito" button.
  if (!consented) return { status: "rejected", reason: "consent" };

  if (existing !== null && text !== "" && existing.budgetUsed >= config.CHAT_MESSAGE_BUDGET) {
    return { status: "rejected", reason: "budget" };
  }

  return db.transaction(async (tx) => {
    let leadId = existing?.lead.id;
    let conversationId = existing?.conversation.id;
    let conversationStatus: ConversationStatus = existing?.conversation.status ?? "active";
    const newEvents: PendingEvent[] = [];

    if (leadId === undefined || conversationId === undefined) {
      // Two tabs opening at once both read "no conversation" and both try to
      // create the lead. `on conflict do nothing` lets the loser re-read the
      // winner's row instead of aborting its whole transaction on the
      // `(agency, channel, externalId)` unique index.
      const [created] = await tx
        .insert(leads)
        .values({
          agencyId: agency.id,
          channel,
          externalId: inbound.externalId,
          consentAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: leads.id, consentAt: leads.consentAt });

      if (created === undefined) {
        const [found] = await tx
          .select({ id: leads.id, consentAt: leads.consentAt })
          .from(leads)
          .where(
            and(
              eq(leads.agencyId, agency.id),
              eq(leads.channel, channel),
              eq(leads.externalId, inbound.externalId),
            ),
          )
          .limit(1);
        if (found === undefined) throw new Error("lead vanished between insert and read");
        leadId = found.id;
        if (found.consentAt === null) {
          await tx.update(leads).set({ consentAt: now, updatedAt: now }).where(eq(leads.id, leadId));
          newEvents.push({ type: "lead.consented", payload: {} });
        }
      } else {
        leadId = created.id;
        newEvents.push({ type: "lead.created", payload: { channel } });
        newEvents.push({ type: "lead.consented", payload: {} });
      }

      const [openConversation] = await tx
        .select({ id: conversations.id, status: conversations.status })
        .from(conversations)
        .where(and(eq(conversations.leadId, leadId), eq(conversations.agencyId, agency.id)))
        .orderBy(desc(conversations.createdAt))
        .limit(1);

      if (openConversation === undefined) {
        const [conversation] = await tx
          .insert(conversations)
          .values({ agencyId: agency.id, leadId, channel, createdAt: now, updatedAt: now })
          .returning({ id: conversations.id });
        conversationId = conversation.id;
        conversationStatus = "active";
      } else {
        conversationId = openConversation.id;
        conversationStatus = openConversation.status;
      }
    } else if (existing?.lead.consentAt == null) {
      await tx
        .update(leads)
        .set({ consentAt: now, updatedAt: now })
        .where(and(eq(leads.id, leadId), eq(leads.agencyId, agency.id)));
      newEvents.push({ type: "lead.consented", payload: {} });
    }

    let messageId: string | null = null;

    if (text !== "") {
      const stored = await tx
        .insert(messages)
        .values({
          conversationId,
          role: "lead",
          content: text,
          metadata: { clientMessageId: inbound.clientMessageId },
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: messages.id });
      messageId = stored[0]?.id ?? null;
    }

    const duplicate = text !== "" && messageId === null;

    if (messageId !== null) {
      await tx
        .update(conversations)
        .set({ lastLeadMessageAt: now, updatedAt: now })
        .where(and(eq(conversations.id, conversationId), eq(conversations.agencyId, agency.id)));
      // Spec 006 FR-010: the lead wrote, so nothing is owed to them any more.
      await cancelFollowup(tx, conversationId, now);
    }

    if (newEvents.length > 0) {
      await tx.insert(events_).values(
        newEvents.map((event) => ({
          agencyId: agency.id,
          leadId,
          conversationId,
          type: event.type,
          actorType: "agent" as const,
          actorUserId: null,
          traceId: null,
          payload: maskPII(event.payload),
          createdAt: now,
        })),
      );
    }

    return {
      status: duplicate ? ("duplicate" as const) : text === "" ? ("consented" as const) : ("stored" as const),
      agencyId: agency.id,
      leadId,
      conversationId,
      conversationStatus,
      messageId,
      consented: true,
    };
  });
}
