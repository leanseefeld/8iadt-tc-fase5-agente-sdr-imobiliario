import { eq } from "drizzle-orm";
import { getConfig } from "../core/config.ts";
import { getDb } from "../db/client.ts";
import { agencies, events } from "../db/schema.ts";
import { WEEK, type Weekday } from "../domain/scheduling.ts";
import type { LeadScope } from "./auth.ts";
import { retimeReminders } from "./reminder.ts";

/**
 * The agency's settings screen (spec 017, backlog item 37): when follow-ups
 * may go out, and the meeting reminder. A sales manager's alone. Stored on the
 * agency row and read at send time, so a change needs no restart.
 */

export interface AgencySettings {
  followupEnabled: boolean;
  windowStart: string;
  windowEnd: string;
  windowDays: Weekday[];
  remindersEnabled: boolean;
  reminderLeadMinutes: number;
  /** Shown, not edited: visits, the agenda and the chat share it (env). */
  timezone: string;
}

export type SettingsResult = { ok: true } | { ok: false; message: string; field?: keyof AgencySettings };

/** What the screen offers for the reminder: in minutes, labelled as hours. */
export const REMINDER_LEAD_CHOICES = [30, 60, 120, 180, 240, 1440] as const;

const TIME = /^([01]\d|2[0-3]):(00|15|30|45)$/;

export async function getAgencySettings(agencyId: string): Promise<AgencySettings> {
  const [row] = await getDb()
    .select({
      followupEnabled: agencies.followupEnabled,
      windowStart: agencies.followupWindowStart,
      windowEnd: agencies.followupWindowEnd,
      windowDays: agencies.followupWindowDays,
      remindersEnabled: agencies.remindersEnabled,
      reminderLeadMinutes: agencies.reminderLeadMinutes,
    })
    .from(agencies)
    .where(eq(agencies.id, agencyId));
  if (row === undefined) throw new Error(`agency ${agencyId} not found`);
  return {
    ...row,
    windowDays: WEEK.filter((day) => row.windowDays.includes(day)),
    timezone: getConfig().FOLLOWUP_TIMEZONE,
  };
}

/** The rules the screen states next to each field, checked again here. */
export function validateSettings(input: Omit<AgencySettings, "timezone">): SettingsResult {
  if (!TIME.test(input.windowStart)) return { ok: false, field: "windowStart", message: "Escolha um horário de início válido." };
  if (!TIME.test(input.windowEnd)) return { ok: false, field: "windowEnd", message: "Escolha um horário de fim válido." };
  if (input.windowStart >= input.windowEnd) {
    return { ok: false, field: "windowEnd", message: "O fim da janela precisa ser depois do início." };
  }
  if (input.windowDays.length === 0 || input.windowDays.some((day) => !WEEK.includes(day))) {
    return { ok: false, field: "windowDays", message: "Deixe pelo menos um dia da semana aberto." };
  }
  if (!(REMINDER_LEAD_CHOICES as readonly number[]).includes(input.reminderLeadMinutes)) {
    return { ok: false, field: "reminderLeadMinutes", message: "Escolha uma das antecedências da lista." };
  }
  return { ok: true };
}

export async function updateAgencySettings(
  scope: LeadScope,
  role: "broker" | "salesManager",
  userId: string,
  input: Omit<AgencySettings, "timezone">,
  now: Date = new Date(),
): Promise<SettingsResult> {
  if (role !== "salesManager") return { ok: false, message: "Só a gerência pode mudar estas configurações." };
  const valid = validateSettings(input);
  if (!valid.ok) return valid;

  const before = await getAgencySettings(scope.agencyId);
  const windowDays = WEEK.filter((day) => input.windowDays.includes(day));
  await getDb().transaction(async (tx) => {
    await tx
      .update(agencies)
      .set({
        followupEnabled: input.followupEnabled,
        followupWindowStart: input.windowStart,
        followupWindowEnd: input.windowEnd,
        followupWindowDays: windowDays,
        remindersEnabled: input.remindersEnabled,
        reminderLeadMinutes: input.reminderLeadMinutes,
      })
      .where(eq(agencies.id, scope.agencyId));
    if (input.reminderLeadMinutes !== before.reminderLeadMinutes) {
      await retimeReminders(tx, scope.agencyId, input.reminderLeadMinutes, now);
    }
    const actor = { agencyId: scope.agencyId, actorType: "user" as const, actorUserId: userId, createdAt: now };
    // The switch keeps the events spec 006 FR-019 gave it.
    if (input.followupEnabled !== before.followupEnabled) {
      await tx.insert(events).values({ ...actor, type: input.followupEnabled ? "followup.enabled" : "followup.disabled", payload: {} });
    }
    await tx.insert(events).values({
      ...actor,
      type: "settings.updated",
      payload: {
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        windowDays,
        remindersEnabled: input.remindersEnabled,
        reminderLeadMinutes: input.reminderLeadMinutes,
      },
    });
  });
  return { ok: true };
}
