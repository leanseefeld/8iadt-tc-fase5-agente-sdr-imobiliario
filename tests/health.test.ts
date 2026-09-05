import test from "node:test";
import assert from "node:assert/strict";
import {
  liveness,
  readiness,
  probe,
  PROBE_TIMEOUT_MS,
  type CheckResult,
} from "../src/core/health.ts";

// Conformance to specs/001-walking-skeleton/contracts/health.md. Items 3 to 12
// may add checks; they may not rename or remove these fields.

test("liveness carries status, process and uptime", () => {
  const report = liveness("app");
  assert.equal(report.status, "alive");
  assert.equal(report.process, "app");
  assert.equal(typeof report.uptimeMs, "number");
  assert.ok(report.uptimeMs >= 0);
});

test("liveness distinguishes the two processes", () => {
  assert.equal(liveness("worker").process, "worker");
});

test("readiness is ready only when every check passes", () => {
  const pass: CheckResult = { name: "database", ok: true, latencyMs: 3 };
  const fail: CheckResult = { name: "database", ok: false, latencyMs: 2000, detail: "timeout" };

  assert.equal(readiness("app", [pass]).status, "ready");
  assert.equal(readiness("app", [pass, fail]).status, "not_ready");
});

test("a failing readiness body has the same shape as a passing one", () => {
  const failing = readiness("worker", [
    { name: "database", ok: false, latencyMs: 1500, detail: "connection refused" },
  ]);
  assert.deepEqual(Object.keys(failing).sort(), ["checks", "process", "status"]);
  assert.equal(failing.checks[0].name, "database");
  assert.equal(failing.checks[0].detail, "connection refused");
});

test("a passing probe reports ok with no detail", async () => {
  const result = await probe("database", async () => undefined);
  assert.equal(result.ok, true);
  assert.equal(result.detail, undefined);
  assert.equal(typeof result.latencyMs, "number");
});

test("a rejecting probe reports the reason as detail", async () => {
  const result = await probe("database", async () => {
    throw new Error("connection refused");
  });
  assert.equal(result.ok, false);
  assert.equal(result.detail, "connection refused");
});

// SC-009: a hanging dependency must not hang the answer.
test("a hanging probe is bounded by its timeout", async () => {
  const startedAt = Date.now();
  const result = await probe("database", () => new Promise(() => {}), 150);
  const elapsed = Date.now() - startedAt;

  assert.equal(result.ok, false);
  assert.equal(result.detail, "timeout");
  assert.ok(elapsed < 1000, `probe took ${elapsed}ms, expected to be cut off near 150ms`);
});

test("the default probe timeout stays inside the 5 second bound", () => {
  assert.ok(PROBE_TIMEOUT_MS < 5000);
});
