"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/core/auth";
import { createLogger } from "@/core/logging";
import { reassignLead as reassignLeadService, scopeForUser } from "@/services/auth";
import {
  assumeConversation,
  returnToAgent,
  sendBrokerReply,
  setLeadStatus,
  type Result,
} from "@/services/handoff";
import { setFollowupEnabled, triggerNow } from "@/services/followup";

/**
 * The five actions of the lead panel.
 *
 * Every one of them re-reads the session and rebuilds the scope server-side. A
 * Server Action is a public endpoint: the only things trusted from the caller
 * are the lead id and the text, and both are checked against the scope before
 * anything is written.
 *
 * They are thin by design — read session, call service, revalidate. The rules
 * live in `services/handoff.ts`, and `Notifier.publish` happens there, after the
 * transaction commits, so other viewers hear about it whoever triggered it.
 */

let log: ReturnType<typeof createLogger> | undefined;
const logger = () => (log ??= createLogger("app", { module: "leads/actions" }));

const UNAUTHENTICATED: Result = { ok: false, message: "Sua sessão expirou. Entre de novo." };

async function withScope(
  action: string,
  leadId: string,
  run: (context: {
    scope: ReturnType<typeof scopeForUser>;
    userId: string;
    role: "broker" | "salesManager";
  }) => Promise<Result>,
): Promise<Result> {
  const session = await getSession();
  if (session === null) return UNAUTHENTICATED;

  const result = await run({
    scope: scopeForUser(session),
    userId: session.userId,
    role: session.role,
  });

  logger().info({ action, leadId, userId: session.userId, ok: result.ok }, "lead action");
  revalidatePath("/leads");
  return result;
}

export async function assumeConversationAction(leadId: string): Promise<Result> {
  return withScope("assume", leadId, ({ scope, userId }) =>
    assumeConversation(scope, leadId, userId),
  );
}

export async function returnToAgentAction(leadId: string): Promise<Result> {
  return withScope("return", leadId, ({ scope, userId }) => returnToAgent(scope, leadId, userId));
}

export async function sendBrokerReplyAction(leadId: string, text: string): Promise<Result> {
  return withScope("reply", leadId, ({ scope, userId }) =>
    sendBrokerReply(scope, leadId, userId, text),
  );
}

export async function setLeadStatusAction(leadId: string, next: string): Promise<Result> {
  return withScope("status", leadId, ({ scope, userId }) =>
    setLeadStatus(scope, leadId, userId, next),
  );
}

/**
 * Reassignment already existed in spec 003, throwing on a broker who tries it.
 * The throw is the right shape there — it is an authorization failure, not an
 * expected outcome — so it is wrapped rather than rewritten.
 */
export async function reassignLeadAction(leadId: string, brokerId: string): Promise<Result> {
  return withScope("reassign", leadId, async ({ role }) => {
    if (role !== "salesManager") {
      return { ok: false, message: "Só um gerente pode transferir um lead." };
    }
    const session = await getSession();
    if (session === null) return UNAUTHENTICATED;

    try {
      await reassignLeadService(session, leadId, brokerId);
      return { ok: true };
    } catch (error) {
      logger().warn({ leadId, err: (error as Error).message }, "reassign refused");
      return { ok: false, message: "Não consegui transferir este lead." };
    }
  });
}

/** Spec 006 FR-017: the demo button — the pending attempt, due now. The sweep sends it. */
export async function triggerFollowupAction(leadId: string): Promise<Result> {
  return withScope("followup-now", leadId, ({ scope }) => triggerNow(scope, leadId));
}

/**
 * Spec 006 FR-019: the agency's follow-up switch. Not about one lead, so it
 * reads the session itself; the role check is in the service, not here.
 */
export async function setFollowupEnabledAction(enabled: boolean): Promise<Result> {
  const session = await getSession();
  if (session === null) return UNAUTHENTICATED;
  const result = await setFollowupEnabled(scopeForUser(session), session.role, session.userId, enabled);
  logger().info({ action: "followup-switch", enabled, userId: session.userId, ok: result.ok }, "agency action");
  revalidatePath("/leads");
  return result;
}
