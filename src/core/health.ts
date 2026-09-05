/**
 * Shared health shapes and the probe helper, per
 * `specs/001-walking-skeleton/contracts/health.md`.
 *
 * Liveness calls no dependency: a sick database must never make a process look
 * like it needs restarting, because restarting will not fix the database.
 */

export type ProcessName = "app" | "worker";

export interface CheckResult {
  name: string;
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

export interface LivenessReport {
  status: "alive";
  process: ProcessName;
  uptimeMs: number;
}

export interface ReadinessReport {
  status: "ready" | "not_ready";
  process: ProcessName;
  checks: CheckResult[];
}

/** Bounds every probe, so a hanging dependency cannot hang the answer. */
export const PROBE_TIMEOUT_MS = 2_000;

export function liveness(name: ProcessName): LivenessReport {
  return {
    status: "alive",
    process: name,
    uptimeMs: Math.round(process.uptime() * 1000),
  };
}

export function readiness(name: ProcessName, checks: CheckResult[]): ReadinessReport {
  return {
    status: checks.every((check) => check.ok) ? "ready" : "not_ready",
    process: name,
    checks,
  };
}

export async function probe(
  name: string,
  run: () => Promise<unknown>,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<CheckResult> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      run(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    return { name, ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      name,
      ok: false,
      latencyMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
