import { randomUUID } from "node:crypto";
import { getPool } from "../../../src/db/client.ts";
import { collectingSink, runTurn, type TurnResult } from "../../../src/agent/orchestrator.ts";
import { recordLeadMessage } from "../../../src/services/conversation.ts";

/**
 * Spec 006's model-driven tests share one shape: a demo-agency lead whose
 * purchase script is already complete and hot, so the very next turn is the
 * offer. Everything a conversation creates is removed by `cleanup`.
 */

export const READY = {
  priceMax: 900_000,
  bedrooms: 2,
  neighborhoods: ["Vila Mariana"],
  urgency: "immediate",
  investorProfile: null,
  ticket: null,
  returnExpectation: null,
  name: "Camila",
  contact: "11987654321",
};

export async function query(sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  return (await getPool().query(sql, params)).rows as Array<Record<string, unknown>>;
}

export interface Lead {
  sessionId: string;
  conversationId: string;
  leadId: string;
  /** One lead message, one committed turn. */
  say(text: string): Promise<Extract<TurnResult, { status: "committed" }>>;
  /** The latest agent message's metadata, as `commitTurn` wrote it. */
  lastMetadata(): Promise<Record<string, unknown>>;
  appointments(): Promise<Array<{ status: string; scheduled_at: Date; type: string; property_id: string | null }>>;
  cleanup(): Promise<void>;
}

export async function qualifiedLead(options: { brokerName?: string; shownPropertyIds?: string[] } = {}): Promise<Lead> {
  const sessionId = `test-${randomUUID()}`;
  const inbound = await recordLeadMessage({
    agencySlug: "demo",
    externalId: sessionId,
    clientMessageId: randomUUID(),
    text: "Quero comprar",
    consent: true,
  });
  if (!("conversationId" in inbound)) throw new Error(JSON.stringify(inbound));
  const { conversationId, leadId } = inbound;

  // Backdated by a second or two. The next lead message gets a JavaScript
  // timestamp (milliseconds, truncated); Postgres' `now()` has microseconds. Two
  // writes in the same millisecond would order the lead's message *before* this
  // reply, and the turn would find nothing to answer.
  await query("update messages set created_at = now() - interval '2 seconds' where conversation_id = $1", [conversationId]);
  await query(
    `insert into messages (conversation_id, role, content, metadata, created_at)
     values ($1, 'agent', $2, $3::jsonb, now() - interval '1 second')`,
    [
      conversationId,
      "Separei algumas opções para você.",
      JSON.stringify(options.shownPropertyIds === undefined ? {} : { propertyIds: options.shownPropertyIds }),
    ],
  );
  await query("update leads set intent = 'purchase', status = 'qualified', score = 100 where id = $1", [leadId]);
  await query("update conversations set slots = $2::jsonb, fallback_streak = 0 where id = $1", [
    conversationId,
    JSON.stringify(READY),
  ]);
  if (options.brokerName !== undefined) {
    await query(
      `update leads set assigned_broker_id = (select u.id from users u join agencies a on a.id = u.agency_id
        where a.slug = 'demo' and u.name = $2) where id = $1`,
      [leadId, options.brokerName],
    );
  }

  return {
    sessionId,
    conversationId,
    leadId,
    async say(text) {
      const message = await recordLeadMessage({
        agencySlug: "demo",
        externalId: sessionId,
        clientMessageId: randomUUID(),
        text,
        consent: true,
      });
      if (message.status !== "stored") throw new Error(JSON.stringify(message));
      const result = await runTurn({ conversationId, sink: collectingSink() });
      if (result.status !== "committed") throw new Error(JSON.stringify(result));
      return result;
    },
    async lastMetadata() {
      const [row] = await query(
        "select metadata from messages where conversation_id = $1 and role = 'agent' order by created_at desc limit 1",
        [conversationId],
      );
      return row.metadata as Record<string, unknown>;
    },
    async appointments() {
      return (await query(
        "select status, scheduled_at, type, property_id from appointments where conversation_id = $1 order by created_at",
        [conversationId],
      )) as never;
    },
    async cleanup() {
      await query("delete from events where conversation_id = $1", [conversationId]);
      await query("delete from appointments where conversation_id = $1", [conversationId]);
      await query("delete from messages where conversation_id = $1", [conversationId]);
      await query("delete from followup_jobs where conversation_id = $1", [conversationId]);
      await query("delete from conversations where id = $1", [conversationId]);
      await query("delete from leads where id = $1", [leadId]);
    },
  };
}

export const OPTIONS = /^(Esse horário .*\. )?Tenho estes horários/;

export function toolNames(metadata: Record<string, unknown>): string[] {
  const calls = metadata.toolCalls;
  return Array.isArray(calls) ? calls.map((call) => (call as { name: string }).name) : [];
}

/**
 * Spec 009 setup: a confirmed meeting written straight to the test database —
 * what the lead already has before the conversation under test starts. With
 * Ana, a purchase broker seeded Mon–Fri 09:00–18:00.
 */
export async function bookDirect(
  lead: Lead,
  meeting: { at: Date; type?: "viewing" | "call"; propertyCode?: string | null },
): Promise<string> {
  const [row] = await query(
    `insert into appointments (agency_id, lead_id, conversation_id, broker_id, property_id, scheduled_at, type, status)
     select c.agency_id, c.lead_id, c.id,
            (select u.id from users u where u.agency_id = c.agency_id and u.name = 'Ana Ribeiro'),
            (select p.id from properties p where p.agency_id = c.agency_id and p.code = $3),
            $2, $4, 'confirmed'
       from conversations c where c.id = $1
     returning id`,
    [lead.conversationId, meeting.at, meeting.propertyCode ?? null, meeting.type ?? (meeting.propertyCode ? "viewing" : "call")],
  );
  return row.id as string;
}

/** The next given weekday at hh:mm in São Paulo, at least two days from now. */
export function nextLocal(weekday: "mon" | "tue" | "wed" | "thu" | "fri", hour: number, minute = 0): Date {
  const names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const day = new Date(Date.now() + 2 * 24 * 60 * 60_000);
  while (names[new Date(day.getTime() - 3 * 60 * 60_000).getUTCDay()] !== weekday) day.setTime(day.getTime() + 24 * 60 * 60_000);
  const local = new Date(day.getTime() - 3 * 60 * 60_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour + 3, minute));
}
