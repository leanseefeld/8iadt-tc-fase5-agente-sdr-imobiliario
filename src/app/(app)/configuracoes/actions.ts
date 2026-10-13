"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/core/auth";
import { createLogger } from "@/core/logging";
import type { Weekday } from "@/domain/scheduling";
import { updateAgencySettings, type SettingsResult } from "@/services/agency-settings";
import { scopeForUser } from "@/services/auth";

/**
 * Spec 017: saving the agency's settings. The role check is in the service;
 * the values are validated there too, whatever the form allowed.
 */

let log: ReturnType<typeof createLogger> | undefined;
const logger = () => (log ??= createLogger("app", { module: "configuracoes/actions" }));

export interface SettingsInput {
  followupEnabled: boolean;
  windowStart: string;
  windowEnd: string;
  windowDays: Weekday[];
  remindersEnabled: boolean;
  reminderLeadMinutes: number;
}

export async function saveSettingsAction(input: SettingsInput): Promise<SettingsResult> {
  const session = await getSession();
  if (session === null) return { ok: false, message: "Sua sessão expirou. Entre de novo." };
  const result = await updateAgencySettings(scopeForUser(session), session.role, session.userId, input);
  logger().info({ action: "settings", userId: session.userId, ok: result.ok }, "agency action");
  revalidatePath("/configuracoes");
  revalidatePath("/followups");
  revalidatePath("/leads");
  return result;
}
