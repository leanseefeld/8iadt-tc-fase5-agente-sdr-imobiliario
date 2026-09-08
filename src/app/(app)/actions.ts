"use server";

import { redirect } from "next/navigation";
import { clearSessionCookie, getSession } from "@/core/auth";
import { createLogger } from "@/core/logging";

let log: ReturnType<typeof createLogger> | undefined;
const logger = () => (log ??= createLogger("app", { module: "auth" }));

/**
 * FR-018: the logout event is logged with the `userId` that is about to stop
 * being authenticated, so the session is read before the cookie is cleared.
 * `redirect()` throws by design, so it sits outside any try/catch.
 */
export async function logoutAction(): Promise<void> {
  const session = await getSession();
  if (session) logger().info({ userId: session.userId }, "logout");

  await clearSessionCookie();
  redirect("/login");
}
