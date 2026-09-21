import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { conversations, events, leads } from "../db/schema.ts";
import { publishQuietly, STATE_CHANNEL } from "../core/notifier.ts";
import { canTransition, isLeadStage, type LeadStage } from "../domain/lead-status.ts";
import { recordOutboundMessage } from "./conversation.ts";
import type { LeadScope } from "./auth.ts";

/**
 * The four writes a broker performs from the lead panel (FR-032 to FR-037).
 *
 * Two rules hold for all of them. Each is a **conditional update** whose `where`
 * carries the precondition, so two brokers clicking *Assumir* at the same moment
 * resolve in the database rather than in a read-then-write that both pass; zero
 * rows updated is the loser, and it gets a sentence, not an exception. And each
 * publishes on `conversation_state` **after** its transaction commits, because a
 * notification about a row nobody can read yet is worse than a late one.
 *
 * Failure here is an expected outcome — a colleague got there first, the stage
 * does not move that way — so the return type is a `Result` carrying the pt-BR
 * message the panel renders, not a thrown error.
 */

export type Result = { ok: true } | { ok: false; message: string };

const ok: Result = { ok: true };
const fail = (message: string): Result => ({ ok: false, message });

interface Target {
  leadId: string;
  conversationId: string;
  agencyId: string;
  stage: LeadStage;
  status: "active" | "paused" | "closed";
  heldByUserId: string | null;
  assignedBrokerId: string | null;
}

/** The lead with its newest conversation, already scoped. `null` = not found. */
async function target(scope: LeadScope, leadId: string): Promise<Target | null> {
  const [row] = await getDb()
    .select({
      leadId: leads.id,
      conversationId: conversations.id,
      agencyId: leads.agencyId,
      stage: leads.status,
      status: conversations.status,
      heldByUserId: conversations.heldByUserId,
      assignedBrokerId: leads.assignedBrokerId,
    })
    .from(leads)
    .innerJoin(
      conversations,
      and(
        eq(conversations.leadId, leads.id),
        sql`${conversations.createdAt} = (
          select max(c2.created_at) from conversations c2 where c2.lead_id = ${leads.id})`,
      ),
    )
    .where(and(eq(leads.id, leadId), eq(leads.agencyId, scope.agencyId)))
    .limit(1);

  return row ?? null;
}

function announce(found: Target, status: "active" | "paused" | "closed"): void {
  publishQuietly(STATE_CHANNEL, {
    conversationId: found.conversationId,
    agencyId: found.agencyId,
    status,
  });
}

/**
 * FR-032. Available at any pipeline stage, including `new` — a broker who wants
 * this conversation takes it, rather than waiting for the agent to give up.
 *
 * The lead is assigned only when nobody owns it: taking over a colleague's lead
 * must not quietly transfer it, which is why reassignment stays a manager's
 * action.
 */
export async function assumeConversation(
  scope: LeadScope,
  leadId: string,
  userId: string,
): Promise<Result> {
  const found = await target(scope, leadId);
  if (found === null) return fail("Lead não encontrado.");
  if (found.status === "closed") return fail("Esta conversa já foi encerrada.");
  if (found.heldByUserId === userId) return fail("Você já está no comando desta conversa.");

  const updated = await getDb().transaction(async (tx) => {
    const rows = await tx
      .update(conversations)
      .set({ status: "paused", heldByUserId: userId, updatedAt: new Date() })
      .where(
        and(
          eq(conversations.id, found.conversationId),
          isNull(conversations.heldByUserId),
          ne(conversations.status, "closed"),
        ),
      )
      .returning({ id: conversations.id });

    if (rows.length === 0) return false;

    if (found.assignedBrokerId === null) {
      await tx
        .update(leads)
        .set({ assignedBrokerId: userId, updatedAt: new Date() })
        .where(and(eq(leads.id, found.leadId), isNull(leads.assignedBrokerId)));
    }

    await tx.insert(events).values({
      agencyId: found.agencyId,
      leadId: found.leadId,
      conversationId: found.conversationId,
      type: "conversation.assumed",
      actorType: "user",
      actorUserId: userId,
      payload: { userId },
    });

    return true;
  });

  if (!updated) return fail("Outro corretor assumiu esta conversa primeiro.");
  announce(found, "paused");
  return ok;
}

/** FR-036. Only the holder hands back: nobody else knows whether they are done. */
export async function returnToAgent(
  scope: LeadScope,
  leadId: string,
  userId: string,
): Promise<Result> {
  const found = await target(scope, leadId);
  if (found === null) return fail("Lead não encontrado.");
  if (found.heldByUserId === null) return fail("Ninguém está no comando desta conversa.");
  if (found.heldByUserId !== userId) return fail("Quem assumiu esta conversa foi outra pessoa.");

  const updated = await getDb().transaction(async (tx) => {
    const rows = await tx
      .update(conversations)
      .set({ status: "active", heldByUserId: null, updatedAt: new Date() })
      .where(
        and(eq(conversations.id, found.conversationId), eq(conversations.heldByUserId, userId)),
      )
      .returning({ id: conversations.id });

    if (rows.length === 0) return false;

    await tx.insert(events).values({
      agencyId: found.agencyId,
      leadId: found.leadId,
      conversationId: found.conversationId,
      type: "conversation.returned",
      actorType: "user",
      actorUserId: userId,
      payload: { userId },
    });

    return true;
  });

  if (!updated) return fail("A conversa mudou de mãos enquanto você olhava.");
  announce(found, "active");
  return ok;
}

/**
 * FR-034/FR-035. The reply goes out through the same path the agent's does —
 * persisted first, announced second — so the widget cannot tell the difference
 * in how it arrives, only in how it is labelled.
 */
export async function sendBrokerReply(
  scope: LeadScope,
  leadId: string,
  userId: string,
  text: string,
): Promise<Result> {
  const content = text.trim();
  if (content === "") return fail("Escreva a mensagem antes de enviar.");

  const found = await target(scope, leadId);
  if (found === null) return fail("Lead não encontrado.");
  if (found.status === "closed") return fail("Esta conversa já foi encerrada.");
  if (found.heldByUserId !== userId) {
    return fail("Assuma a conversa antes de responder ao lead.");
  }

  const written = await recordOutboundMessage({
    conversationId: found.conversationId,
    role: "broker",
    userId,
    content,
  });
  if (written === null) return fail("Não consegui enviar a mensagem. Tente de novo.");

  // `recordOutboundMessage` already rang the message channel; this one tells the
  // dashboard's list, which watches the agency rather than the conversation.
  announce(found, found.status);
  return ok;
}

/** FR-037. The transition table lives in `domain/`; this only persists it. */
export async function setLeadStatus(
  scope: LeadScope,
  leadId: string,
  userId: string,
  next: string,
): Promise<Result> {
  if (!isLeadStage(next)) return fail("Etapa desconhecida.");

  const found = await target(scope, leadId);
  if (found === null) return fail("Lead não encontrado.");
  if (found.stage === next) return fail("O lead já está nesta etapa.");
  if (!canTransition(found.stage, next)) {
    return fail("O funil não volta atrás: escolha uma etapa adiante, ganho ou perdido.");
  }

  const updated = await getDb().transaction(async (tx) => {
    const rows = await tx
      .update(leads)
      .set({ status: next, updatedAt: new Date() })
      .where(and(eq(leads.id, found.leadId), eq(leads.status, found.stage)))
      .returning({ id: leads.id });

    if (rows.length === 0) return false;

    await tx.insert(events).values({
      agencyId: found.agencyId,
      leadId: found.leadId,
      conversationId: found.conversationId,
      type: "lead.status_changed",
      actorType: "user",
      actorUserId: userId,
      payload: { from: found.stage, to: next },
    });

    return true;
  });

  if (!updated) return fail("A etapa mudou enquanto você olhava. Recarregue a ficha.");
  announce(found, found.status);
  return ok;
}
