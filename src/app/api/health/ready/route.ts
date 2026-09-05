import { NextResponse } from "next/server";
import { readiness } from "@/core/health";
import { checkDatabase } from "@/services/health";

export const dynamic = "force-dynamic";

/**
 * Readiness: the database only. The model provider is deliberately absent —
 * a provider outage leaves the application able to serve every page, and
 * failing readiness for it would pull a healthy container out of rotation.
 * Provider reachability is `npm run doctor`.
 */
export async function GET() {
  const report = readiness("app", [await checkDatabase()]);
  return NextResponse.json(report, { status: report.status === "ready" ? 200 : 503 });
}
