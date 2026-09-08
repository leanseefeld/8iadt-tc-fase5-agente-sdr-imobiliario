"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { setSessionCookie } from "@/core/auth";
import { createLogger } from "@/core/logging";
import { login } from "@/services/auth";

let log: ReturnType<typeof createLogger> | undefined;
const logger = () => (log ??= createLogger("app", { module: "auth" }));

/**
 * FR-002 / FR-018. `login()` already tells "no such user" from "wrong
 * password" apart to no one — it returns `null` for both and does its own
 * `warn` logging. This action only has two outcomes to handle: a session, or
 * a redirect back to the form with the one generic error.
 *
 * `redirect()` throws by design (Next.js control flow), so both calls to it
 * below sit outside any try/catch — wrapping them would turn the redirect
 * into a caught exception instead of a navigation.
 */
export async function loginAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const sourceIp = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  const session = await login(email, password, sourceIp);

  if (!session) {
    redirect("/login?erro=1");
  }

  await setSessionCookie(session);
  logger().info({ userId: session.userId }, "login");
  redirect("/leads");
}
