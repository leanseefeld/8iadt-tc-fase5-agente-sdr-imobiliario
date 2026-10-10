"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/core/auth";
import { createLogger } from "@/core/logging";
import { scopeForUser } from "@/services/auth";
import type { Result } from "@/services/followup";
import { cancelQueued, sendNow, sendOwnFollowup } from "@/services/followup-queue";

/**
 * Spec 017: the queue's three actions. A Server Action is a public endpoint, so
 * the session is read again and only the job id (and the broker's text) come
 * from the caller; the service checks the job belongs to this agency.
 */

let log: ReturnType<typeof createLogger> | undefined;
const logger = () => (log ??= createLogger("app", { module: "followups/actions" }));

async function act(
  action: string,
  jobId: string,
  run: (scope: ReturnType<typeof scopeForUser>, userId: string) => Promise<Result>,
): Promise<Result> {
  const session = await getSession();
  if (session === null) return { ok: false, message: "Sua sessão expirou. Entre de novo." };
  const result = await run(scopeForUser(session), session.userId);
  logger().info({ action, jobId, userId: session.userId, ok: result.ok }, "queue action");
  revalidatePath("/followups");
  revalidatePath("/leads");
  return result;
}

export async function sendNowAction(jobId: string): Promise<Result> {
  return act("send-now", jobId, (scope, userId) => sendNow(scope, userId, jobId));
}

export async function sendOwnAction(jobId: string, text: string): Promise<Result> {
  return act("send-own", jobId, (scope, userId) => sendOwnFollowup(scope, userId, jobId, text));
}

export async function cancelQueuedAction(jobId: string): Promise<Result> {
  return act("cancel", jobId, (scope, userId) => cancelQueued(scope, userId, jobId));
}
