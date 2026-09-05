import { NextResponse } from "next/server";
import { liveness } from "@/core/health";

export const dynamic = "force-dynamic";

/** Liveness: no dependency calls, so a sick database cannot fail it. */
export function GET() {
  return NextResponse.json(liveness("app"));
}
