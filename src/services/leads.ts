import { and, desc, eq, gt, isNull, sql, type SQL } from "drizzle-orm";
import { getConfig } from "../core/config.ts";
import { getDb } from "../db/client.ts";
import { conversations, events, leads, messages, users } from "../db/schema.ts";
import { readSlots } from "./conversation.ts";
import { temperature, type Temperature } from "../domain/score.ts";
import type { LeadStage } from "../domain/lead-status.ts";
import type { Intent, Slots } from "../domain/slots.ts";
import type { LeadScope } from "./auth.ts";

/**
 * The broker's two reads: the queue and one lead's file.
 *
 * Every query takes the `LeadScope` from `scopeForUser` (spec 003) and applies
 * `agencyId` in SQL. No caller passes a raw agency id, and `mine` is a filter on
 * top of that scope — never a substitute for it, or a pasted URL would be a
 * cross-tenant read (FR-019).
 *
 * The score is **read here, never computed**: `leads.score` is written by the
 * turn (spec 004) and its rules are being rewritten by ADR 20. The only thing
 * this module derives from it is the band, through `domain/score.temperature`,
 * so when the weights move the dashboard follows with them.
 */

export const LEAD_FILTERS = [
  "todos",
  "ao_vivo",
  "aguardando",
  "visita_marcada",
  "sem_resposta",
] as const;

export type LeadFilter = (typeof LEAD_FILTERS)[number];

export function isLeadFilter(value: string): value is LeadFilter {
  return (LEAD_FILTERS as readonly string[]).includes(value);
}

/** What a conversation is doing, as the row's chip reads it (§7). */
export type ConversationState =
  | { kind: "agent" }
  | { kind: "held"; byName: string }
  | { kind: "waiting" }
  | { kind: "closed" };

export interface LeadRow {
  id: string;
  name: string | null;
  intent: Intent;
  stage: LeadStage;
  score: number;
  temperature: Temperature;
  slots: Slots;
  previewLine: string | null;
  lastLeadMessageAt: Date | null;
  live: boolean;
  conversation: ConversationState;
}

export interface LeadQuery {
  filter: LeadFilter;
  mine: boolean;
  userId: string;
  search?: string;
  page: number;
}

export interface LeadList {
  rows: LeadRow[];
  total: number;
  page: number;
  pageSize: number;
}

function conversationState(row: {
  status: "active" | "paused" | "closed";
  heldByUserId: string | null;
  holderName: string | null;
}): ConversationState {
  if (row.status === "closed") return { kind: "closed" };
  if (row.status === "paused") {
    return row.heldByUserId === null
      ? { kind: "waiting" }
      : { kind: "held", byName: row.holderName ?? "Corretor" };
  }
  return { kind: "agent" };
}

/**
 * One query for the page, `count(*) over ()` for the total — a second
 * `select count(*)` would be a second scan of the same predicate, and SC-003
 * asks for a fixed number of queries per render whatever the row count.
 *
 * A lead owns one conversation (`modelo-de-dados.md` §1); where an older lead
 * carries more than one, the newest wins, which is the same rule
 * `recordLeadMessage` applies when it adopts one.
 */
export async function listLeads(scope: LeadScope, query: LeadQuery): Promise<LeadList> {
  const config = getConfig();
  const pageSize = config.LEADS_PAGE_SIZE;
  const page = Math.max(1, query.page);
  const liveSince = new Date(Date.now() - config.DASHBOARD_LIVE_WINDOW_MINUTES * 60_000);

  const conditions: SQL[] = [eq(leads.agencyId, scope.agencyId)];
  if (query.mine) conditions.push(eq(leads.assignedBrokerId, query.userId));

  if (query.filter === "ao_vivo") {
    conditions.push(gt(conversations.lastLeadMessageAt, liveSince));
  } else if (query.filter === "aguardando") {
    conditions.push(eq(conversations.status, "paused"));
    conditions.push(isNull(conversations.heldByUserId));
  } else if (query.filter === "visita_marcada") {
    // Spec 006 FR-008b: derived from a confirmed meeting still to come, not
    // from the stage. Stages only move forward (ADR 19), so a cancelled meeting
    // would otherwise leave the lead marked *Visita marcada* with nothing booked.
    conditions.push(sql`exists (
      select 1 from appointments a
       where a.lead_id = ${leads.id} and a.status = 'confirmed' and a.scheduled_at >= now()
    )`);
  } else if (query.filter === "sem_resposta") {
    conditions.push(eq(conversations.followupState, "exhausted"));
  }

  const term = query.search?.trim();
  if (term !== undefined && term !== "") {
    const pattern = `%${term}%`;
    conditions.push(sql`(
      ${leads.name} ilike ${pattern}
      or ${leads.phone} ilike ${pattern}
      or ${leads.email} ilike ${pattern}
      or ${conversations.previewLine} ilike ${pattern}
    )`);
  }

  const rows = await getDb()
    .select({
      id: leads.id,
      name: leads.name,
      intent: leads.intent,
      stage: leads.status,
      score: leads.score,
      slots: conversations.slots,
      previewLine: conversations.previewLine,
      lastLeadMessageAt: conversations.lastLeadMessageAt,
      conversationStatus: conversations.status,
      heldByUserId: conversations.heldByUserId,
      holderName: users.name,
      total: sql<number>`count(*) over ()::int`,
    })
    .from(leads)
    .innerJoin(
      conversations,
      and(
        eq(conversations.leadId, leads.id),
        // The newest conversation of this lead, and only it.
        sql`${conversations.createdAt} = (
          select max(c2.created_at) from conversations c2 where c2.lead_id = ${leads.id})`,
      ),
    )
    .leftJoin(users, eq(users.id, conversations.heldByUserId))
    .where(and(...conditions))
    .orderBy(desc(leads.score), sql`${conversations.lastLeadMessageAt} desc nulls last`)
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return {
    rows: rows.map((row) => ({
      id: row.id,
      name: row.name,
      intent: row.intent,
      stage: row.stage,
      score: row.score,
      temperature: temperature(row.score),
      slots: readSlots(row.slots),
      previewLine: row.previewLine,
      lastLeadMessageAt: row.lastLeadMessageAt,
      live: row.lastLeadMessageAt !== null && row.lastLeadMessageAt > liveSince,
      conversation: conversationState({
        status: row.conversationStatus,
        heldByUserId: row.heldByUserId,
        holderName: row.holderName,
      }),
    })),
    total: rows[0]?.total ?? 0,
    page,
    pageSize,
  };
}

/**
 * The agency's brokers, for the manager's reassignment control (FR-037).
 *
 * It exists because the alternative shipped first and was worse: a text field
 * asking a person to type a UUID. A control whose effect is not clear from its
 * label is a defect under principle X, and an id is not a label.
 */
export async function listAgencyBrokers(
  scope: LeadScope,
): Promise<Array<{ id: string; name: string }>> {
  return getDb()
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.agencyId, scope.agencyId), eq(users.role, "broker")))
    .orderBy(users.name);
}

export interface PanelMessage {
  id: string;
  role: "lead" | "agent" | "broker" | "system";
  content: string;
  createdAt: Date;
  propertyIds: string[];
  /** Named when a person wrote it, so the transcript can say who (FR-029). */
  authorName: string | null;
}

export interface PanelEvent {
  id: string;
  type: string;
  actorType: "lead" | "user" | "agent" | "worker" | "system";
  actorName: string | null;
  payload: Record<string, unknown>;
  traceId: string | null;
  createdAt: Date;
}

export interface LeadDetail {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  intent: Intent;
  stage: LeadStage;
  score: number;
  temperature: Temperature;
  assignedBrokerId: string | null;
  assignedBrokerName: string | null;
  createdAt: Date;
  conversation: {
    id: string;
    status: "active" | "paused" | "closed";
    heldByUserId: string | null;
    heldByName: string | null;
    state: ConversationState;
    slots: Slots;
    summary: string | null;
    summaryUpdatedAt: Date | null;
    /**
     * There are turns the summariser has not consumed yet, so what the panel
     * shows is behind the conversation.
     *
     * Read from the outbox rather than by comparing timestamps to the last
     * message, and the difference matters: the panel promises the summary
     * updates shortly, and that promise is only true when work is actually
     * queued. A lead message with no agent turn behind it yet produces no
     * pending row — nothing is owed, so nothing is claimed.
     */
    summaryStale: boolean;
    lastLeadMessageAt: Date | null;
  };
  messages: PanelMessage[];
  events: PanelEvent[];
}

/**
 * Three queries, fixed: the lead with its conversation, the whole transcript
 * (never a window — FR-029), and the trail. `null` when the lead is outside the
 * scope, so a pasted URL is a not-found rather than a panel with an error in it.
 */
export async function getLeadDetail(scope: LeadScope, leadId: string): Promise<LeadDetail | null> {
  const db = getDb();

  const [row] = await db
    .select({
      id: leads.id,
      name: leads.name,
      phone: leads.phone,
      email: leads.email,
      intent: leads.intent,
      stage: leads.status,
      score: leads.score,
      assignedBrokerId: leads.assignedBrokerId,
      createdAt: leads.createdAt,
      conversationId: conversations.id,
      conversationStatus: conversations.status,
      heldByUserId: conversations.heldByUserId,
      slots: conversations.slots,
      summary: conversations.summary,
      summaryUpdatedAt: conversations.summaryUpdatedAt,
      lastLeadMessageAt: conversations.lastLeadMessageAt,
      // Served by `events_pending_turns_idx`; no extra round trip.
      summaryStale: sql<boolean>`exists (
        select 1 from events pending
         where pending.conversation_id = ${conversations.id}
           and pending.type = 'conversation.turn'
           and pending.processed_at is null)`,
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

  if (row === undefined) return null;

  const names = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.agencyId, scope.agencyId));
  const nameById = new Map(names.map((user) => [user.id, user.name]));

  const transcript = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      metadata: messages.metadata,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, row.conversationId))
    .orderBy(messages.createdAt, messages.id);

  const trail = await db
    .select({
      id: events.id,
      type: events.type,
      actorType: events.actorType,
      actorUserId: events.actorUserId,
      payload: events.payload,
      traceId: events.traceId,
      createdAt: events.createdAt,
    })
    .from(events)
    .where(and(eq(events.leadId, leadId), eq(events.agencyId, scope.agencyId)))
    .orderBy(desc(events.createdAt), desc(events.id));

  const heldByName = row.heldByUserId === null ? null : (nameById.get(row.heldByUserId) ?? null);

  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    intent: row.intent,
    stage: row.stage,
    score: row.score,
    temperature: temperature(row.score),
    assignedBrokerId: row.assignedBrokerId,
    assignedBrokerName:
      row.assignedBrokerId === null ? null : (nameById.get(row.assignedBrokerId) ?? null),
    createdAt: row.createdAt,
    conversation: {
      id: row.conversationId,
      status: row.conversationStatus,
      heldByUserId: row.heldByUserId,
      heldByName,
      state: conversationState({
        status: row.conversationStatus,
        heldByUserId: row.heldByUserId,
        holderName: heldByName,
      }),
      slots: readSlots(row.slots),
      summary: row.summary,
      summaryUpdatedAt: row.summaryUpdatedAt,
      summaryStale: row.summaryStale,
      lastLeadMessageAt: row.lastLeadMessageAt,
    },
    messages: transcript.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      propertyIds: Array.isArray(message.metadata.propertyIds)
        ? (message.metadata.propertyIds as string[])
        : [],
      authorName:
        message.role === "broker" && typeof message.metadata.userId === "string"
          ? (nameById.get(message.metadata.userId) ?? null)
          : null,
    })),
    events: trail.map((event) => ({
      id: event.id,
      type: event.type,
      actorType: event.actorType,
      actorName: event.actorUserId === null ? null : (nameById.get(event.actorUserId) ?? null),
      payload: event.payload,
      traceId: event.traceId,
      createdAt: event.createdAt,
    })),
  };
}
