import { sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import type { LeadScope } from "./auth.ts";

/**
 * The four numbers above the queue (FR-018), cumulative over the agency — no
 * window, because a window over a days-old demo database shows four zeros.
 *
 * One statement. Two of the four are zero until spec 006 lands, and that is the
 * correct reading rather than a missing feature: nothing has booked a visit yet
 * and nothing has recovered a lead yet.
 *
 * The qualification rate reads `leads.status`, not a `lead.qualified` event.
 * The event is not written today and its definition moves with ADR 20's spec;
 * the stage says the same thing with one dependency fewer.
 */

export interface FunnelMetrics {
  /** Median seconds from a lead arriving to the agent's first message. */
  medianFirstResponseSeconds: number | null;
  qualifiedLeads: number;
  totalLeads: number;
  /** `qualifiedLeads / totalLeads`, or null with no leads at all. */
  qualificationRate: number | null;
  confirmedAppointments: number;
  recoveredLeads: number;
}

interface MetricsRow extends Record<string, unknown> {
  median_first_response_seconds: string | number | null;
  qualified_leads: string | number;
  total_leads: string | number;
  confirmed_appointments: string | number;
  recovered_leads: string | number;
}

/** Postgres returns bigint and numeric as strings through `pg`. */
function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function getFunnelMetrics(scope: LeadScope): Promise<FunnelMetrics> {
  const result = await getDb().execute<MetricsRow>(sql`
    with first_response as (
      select l.id,
             extract(epoch from (
               (select min(m.created_at)
                  from messages m
                  join conversations c on c.id = m.conversation_id
                 where c.lead_id = l.id and m.role = 'agent')
               - (select min(e.created_at)
                    from events e
                   where e.lead_id = l.id and e.type = 'lead.created'))) as seconds
        from leads l
       where l.agency_id = ${scope.agencyId}
    )
    select
      -- Positive seconds only: it drops rows where one half of the pair is
      -- missing or out of order. A negative first response is bad data, not a
      -- fast agent.
      (select percentile_cont(0.5) within group (order by seconds)
         from first_response where seconds is not null and seconds > 0)
         as median_first_response_seconds,
      (select count(*) from leads
        where agency_id = ${scope.agencyId}
          and status in ('qualified', 'scheduled', 'visited', 'won')) as qualified_leads,
      (select count(*) from leads where agency_id = ${scope.agencyId}) as total_leads,
      (select count(*) from appointments
        where agency_id = ${scope.agencyId} and status = 'confirmed') as confirmed_appointments,
      (select count(*) from events
        where agency_id = ${scope.agencyId} and type = 'followup.recovered') as recovered_leads
  `);

  const row = result.rows[0];
  const qualified = toNumber(row?.qualified_leads ?? 0) ?? 0;
  const total = toNumber(row?.total_leads ?? 0) ?? 0;

  return {
    medianFirstResponseSeconds: toNumber(row?.median_first_response_seconds ?? null),
    qualifiedLeads: qualified,
    totalLeads: total,
    qualificationRate: total === 0 ? null : qualified / total,
    confirmedAppointments: toNumber(row?.confirmed_appointments ?? 0) ?? 0,
    recoveredLeads: toNumber(row?.recovered_leads ?? 0) ?? 0,
  };
}
