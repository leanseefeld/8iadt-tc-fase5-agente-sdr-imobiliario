import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verify } from "@/core/auth";
import { createLogger } from "@/core/logging";

/**
 * The guard, and the only place a failed verification turns into a redirect
 * (FR-008). One check in front of the `(app)` route group beats a check per
 * page, which is a check somebody eventually forgets to add.
 *
 * `proxy.ts`, not `middleware.ts`: Next.js 16 deprecated that convention and
 * renamed it. Same API, Node.js runtime by default.
 *
 * The public chat route group is not in the matcher, so it is untouched
 * (FR-009) — the guard never sees those requests at all.
 */

let log: ReturnType<typeof createLogger> | undefined;
const logger = () => (log ??= createLogger("app", { module: "guard" }));

export async function proxy(request: NextRequest): Promise<NextResponse> {
  // `verify` returns null rather than throwing, so a malformed or tampered
  // cookie takes the same branch as no cookie at all: fail closed.
  if (await verify(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  // No `userId` on this line because there is no session to name (FR-018),
  // and no query string carried over: `/login` takes no return-to parameter
  // (spec.md clarification 1 — login always lands on `/leads`).
  logger().info({ path: request.nextUrl.pathname }, "unauthenticated request redirected to login");

  const destination = request.nextUrl.clone();
  destination.pathname = "/login";
  destination.search = "";
  return NextResponse.redirect(destination);
}

export const config = {
  matcher: ["/leads/:path*", "/agenda/:path*", "/catalogo/:path*"],
};
