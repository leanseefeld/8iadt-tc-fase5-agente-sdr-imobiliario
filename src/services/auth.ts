import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import { newSession, type SessionPayload } from "../core/auth.ts";
import { createLogger } from "../core/logging.ts";
import { getDb } from "../db/client.ts";
import { events, leads, users } from "../db/schema.ts";

/**
 * The only module in this slice that touches `users` and `leads`. The login
 * form, the shell layout and the request guard all come through here or
 * through `core/auth.ts` — never through `db/` (constitution IV).
 *
 * Contracts: `specs/003-auth-app-shell/contracts/scope-for-user.md`.
 */

let log: ReturnType<typeof createLogger> | undefined;
const logger = () => (log ??= createLogger("app", { module: "auth" }));

/**
 * FR-002: one outcome for "no such user", "wrong password" and malformed
 * input — `null`. The caller has no way to tell them apart, so neither does
 * the person at the form.
 *
 * FR-016: a failure is logged at `warn` with the attempted e-mail and the
 * source IP. The password is never an argument to the logger.
 */
export async function login(
  email: string,
  password: string,
  sourceIp: string,
): Promise<SessionPayload | null> {
  const normalized = email.trim().toLowerCase();

  const refuse = (reason: string): null => {
    logger().warn({ email: normalized, sourceIp, reason }, "failed login attempt");
    return null;
  };

  if (normalized === "" || password === "") return refuse("empty credentials");

  const [user] = await getDb()
    .select({
      id: users.id,
      agencyId: users.agencyId,
      role: users.role,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.email, normalized));

  if (!user) return refuse("unknown email");
  if (!(await bcrypt.compare(password, user.passwordHash))) return refuse("wrong password");

  return newSession({ userId: user.id, agencyId: user.agencyId, role: user.role });
}

export interface LeadScope {
  agencyId: string;
  /**
   * A UI default, not a permission. Spec 005's "Meus leads" list starts
   * filtered to the signed-in broker's own leads; the query underneath is
   * scoped by `agencyId` alone, for both roles.
   */
  defaultOwnLeadsOnly: boolean;
}

/** Pure, no I/O — callers put `agencyId` into their own `where` clause. */
export function scopeForUser(session: SessionPayload): LeadScope {
  return {
    agencyId: session.agencyId,
    defaultOwnLeadsOnly: session.role === "broker",
  };
}

/**
 * FR-012. A `broker` session gets no partial effect: the role check runs
 * before anything is read. Cross-agency reassignment is impossible by
 * construction — both the lead and the target broker are looked up inside
 * `session.agencyId` — rather than by an extra guard that could be forgotten.
 *
 * The `lead.reassigned` event is written here, in the same transaction as the
 * update, so no caller can perform the one without the other.
 */
export async function reassignLead(
  session: SessionPayload,
  leadId: string,
  newBrokerId: string,
): Promise<void> {
  if (session.role !== "salesManager") {
    throw new Error("only a salesManager may reassign a lead");
  }

  const db = getDb();

  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.id, newBrokerId), eq(users.agencyId, session.agencyId), eq(users.role, "broker")),
    );
  if (!target) throw new Error("the target user is not a broker of this agency");

  const [lead] = await db
    .select({ id: leads.id, assignedBrokerId: leads.assignedBrokerId })
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.agencyId, session.agencyId)));
  if (!lead) throw new Error("no such lead in this agency");

  await db.transaction(async (tx) => {
    await tx
      .update(leads)
      .set({ assignedBrokerId: newBrokerId, updatedAt: new Date() })
      .where(eq(leads.id, lead.id));

    await tx.insert(events).values({
      agencyId: session.agencyId,
      leadId: lead.id,
      type: "lead.reassigned",
      actorType: "user",
      actorUserId: session.userId,
      payload: { fromBrokerId: lead.assignedBrokerId, toBrokerId: newBrokerId },
    });
  });

  logger().info(
    { userId: session.userId, leadId: lead.id, toBrokerId: newBrokerId },
    "lead reassigned",
  );
}
