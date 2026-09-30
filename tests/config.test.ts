import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, configKeys, REQUIRED_KEYS } from "../src/core/config.ts";

const valid: Record<string, string> = {
  PROVIDER_BASE_URL: "http://provider.test/v1",
  PROVIDER_API_KEY: "a-key",
  MODEL_ID: "gemma4:12b",
  DATABASE_URL: "postgresql://sdr:sdr@db:5432/sdr",
  AUTH_SECRET: "a-signing-secret",
};

test("accepts an environment carrying only the required keys", () => {
  const config = loadConfig(valid);
  assert.equal(config.MODEL_ID, "gemma4:12b");
});

// The one default that is not a constant: reasoning tokens are spent from the
// same ceiling, so 600 would leave the answer empty.
test("MODEL_MAX_OUTPUT_TOKENS defaults higher when thinking is on", () => {
  assert.equal(loadConfig(valid).MODEL_MAX_OUTPUT_TOKENS, 600);
  assert.equal(loadConfig({ ...valid, MODEL_THINKING: "true" }).MODEL_MAX_OUTPUT_TOKENS, 2_000);
  assert.equal(
    loadConfig({ ...valid, MODEL_THINKING: "true", MODEL_MAX_OUTPUT_TOKENS: "900" })
      .MODEL_MAX_OUTPUT_TOKENS,
    900,
  );
});

test("CHAT_TYPING_DELAY_MS parses into a range, and 0-0 disables the pause", () => {
  assert.deepEqual(loadConfig(valid).CHAT_TYPING_DELAY_MS, { minMs: 300, maxMs: 800 });
  assert.deepEqual(loadConfig({ ...valid, CHAT_TYPING_DELAY_MS: "0-0" }).CHAT_TYPING_DELAY_MS, {
    minMs: 0,
    maxMs: 0,
  });
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
  ["CHAT_TYPING_DELAY_MS", "300"],
  ["CHAT_TYPING_DELAY_MS", "800-300"],
  ["MODEL_MAX_OUTPUT_TOKENS", "0"],
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
  for (const key of ["LANGFUSE_PUBLIC_KEY", "FOLLOWUP_MAX_ATTEMPTS"]) {
    assert.ok(configKeys.includes(key), `${key} missing from the schema`);
  }
});

test("spec 006: scheduling and follow-up keys default and parse", () => {
  const config = loadConfig(valid);
  assert.equal(config.FOLLOWUP_FIRST_DELAY_MINUTES, 240);
  assert.equal(config.FOLLOWUP_BACKOFF_FACTOR, 3);
  assert.equal(config.FOLLOWUP_BATCH_SIZE, 20);
  assert.equal(config.SCHEDULING_MIN_NOTICE_MINUTES, 120);
  assert.deepEqual(config.SCHEDULING_PREFERRED_TIMES, ["10:00", "14:00", "16:30", "09:00", "11:00"]);
  // The order written is the preference, so it is kept, not sorted.
  assert.deepEqual(
    loadConfig({ ...valid, SCHEDULING_PREFERRED_TIMES: "16:30, 09:00" }).SCHEDULING_PREFERRED_TIMES,
    ["16:30", "09:00"],
  );
  assert.throws(() => loadConfig({ ...valid, SCHEDULING_PREFERRED_TIMES: "10h" }));
});
