"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/core/auth";
import { createLogger } from "@/core/logging";
import { markAppointmentStatus, type AgendaResult } from "@/services/scheduling";

/**
 * Spec 006 FR-008: the two things a broker does to a meeting from the agenda.
 * The session is read again here — a Server Action is a public endpoint — and
 * the service checks the meeting belongs to this broker, or to this agency for
 * a manager, before anything moves.
 */

let log: ReturnType<typeof createLogger> | undefined;
const logger = () => (log ??= createLogger("app", { module: "agenda/actions" }));

async function mark(appointmentId: string, status: "done" | "cancelled"): Promise<AgendaResult> {
  const session = await getSession();
  if (session === null) return { ok: false, message: "Sua sessão expirou. Entre de novo." };
  const result = await markAppointmentStatus(
    { agencyId: session.agencyId, userId: session.userId, role: session.role },
    appointmentId,
    status,
  );
  logger().info({ appointmentId, status, userId: session.userId, ok: result.ok }, "agenda action");
  revalidatePath("/agenda");
  revalidatePath("/leads");
  return result;
}

export async function markDone(appointmentId: string): Promise<AgendaResult> {
  return mark(appointmentId, "done");
}

export async function markCancelled(appointmentId: string): Promise<AgendaResult> {
  return mark(appointmentId, "cancelled");
}
