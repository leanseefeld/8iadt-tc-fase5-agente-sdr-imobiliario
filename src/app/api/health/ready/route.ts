import { NextResponse } from "next/server";
import { readiness } from "@/core/health";
import { checkDatabase, checkMigrations } from "@/services/health";

export const dynamic = "force-dynamic";

/**
 * Readiness: database and migrations. The model provider is deliberately
 * absent — a provider outage leaves the application able to serve every
 * page, and failing readiness for it would pull a healthy container out of
 * rotation. Provider reachability is `npm run doctor`.
 *
 * `migrations` is additive to spec 001's contract (FR-007) — every field it
 * defined is unchanged.
 */
export async function GET() {
  const report = readiness("app", [await checkDatabase(), await checkMigrations()]);
  return NextResponse.json(report, { status: report.status === "ready" ? 200 : 503 });
}
