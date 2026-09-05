import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, configKeys, REQUIRED_KEYS } from "../src/core/config.ts";

const valid: Record<string, string> = {
  PROVIDER_BASE_URL: "http://provider.test/v1",
  PROVIDER_API_KEY: "a-key",
  MODEL_ID: "gemma4:12b",
  DATABASE_URL: "postgresql://sdr:sdr@db:5432/sdr",
};

test("accepts an environment carrying only the required keys", () => {
  const config = loadConfig(valid);
  assert.equal(config.MODEL_ID, "gemma4:12b");
});

test("fills documented defaults for optional keys", () => {
  const config = loadConfig(valid);
  assert.equal(config.APP_PORT, 3100);
  assert.equal(config.WORKER_HEALTH_PORT, 3101);
  assert.equal(config.DB_PORT, 55432);
  assert.equal(config.WORKER_SWEEP_INTERVAL_MS, 900_000);
  assert.equal(config.LOG_LEVEL, "info");
  assert.equal(config.WATCHPACK_POLLING, false);
  assert.equal(config.FOLLOWUP_TIMEZONE, "America/Sao_Paulo");
});

// FR-019 / SC-007: every required key, absent or blank, stops the process with a
// message naming that key. Table-driven so adding a required key adds a case.
for (const key of REQUIRED_KEYS) {
  test(`rejects a missing ${key} and names it`, () => {
    const env = { ...valid };
    delete env[key];
    assert.throws(() => loadConfig(env), (error: Error) => error.message.includes(key));
  });

  test(`treats a blank ${key} as absent`, () => {
    assert.throws(
      () => loadConfig({ ...valid, [key]: "   " }),
      (error: Error) => error.message.includes(key),
    );
  });
}

const malformed: Array<[string, string]> = [
  ["PROVIDER_BASE_URL", "not-a-url"],
  ["DATABASE_URL", "mysql://host/db"],
  ["APP_PORT", "99999"],
  ["WORKER_SWEEP_INTERVAL_MS", "-1"],
  ["LOG_LEVEL", "chatty"],
  ["FOLLOWUP_WINDOW_START", "9am"],
];

for (const [key, value] of malformed) {
  test(`rejects a malformed ${key} and names it`, () => {
    assert.throws(
      () => loadConfig({ ...valid, [key]: value }),
      (error: Error) => error.message.includes(key),
    );
  });
}

test("optional keys nothing reads yet are still declared", () => {
  for (const key of ["AUTH_SECRET", "LANGFUSE_PUBLIC_KEY", "FOLLOWUP_MAX_ATTEMPTS"]) {
    assert.ok(configKeys.includes(key), `${key} missing from the schema`);
  }
});
