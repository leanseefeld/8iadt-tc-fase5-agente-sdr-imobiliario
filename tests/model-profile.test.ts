import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configKeys } from "../src/core/config.ts";
import { loadModelProfile } from "../src/core/model-profile.ts";

/**
 * Model profiles (constitution VI as amended 08/10/2026, ADR 23): one YAML file
 * per model under `config/models/`, named by `MODEL_PROFILE`.
 */
const PROFILES = fileURLToPath(new URL("../config/models", import.meta.url));
const ENV = {
  OMLX_API_KEY: "local-key",
  AZURE_OPENAI_BASE_URL: "https://resource.openai.azure.com/openai/v1",
  AZURE_OPENAI_API_KEY: "azure-key",
};

function scratch(name: string, yaml: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "profiles-"));
  writeFileSync(path.join(directory, `${name}.yaml`), yaml);
  return directory;
}

test("every committed profile loads", () => {
  const names = readdirSync(PROFILES).filter((file) => file.endsWith(".yaml")).map((file) => file.slice(0, -5));
  assert.ok(names.includes("omlx_gemma4_e4b"));
  for (const name of names) {
    const profile = loadModelProfile(name, PROFILES, ENV, configKeys);
    assert.equal(profile.name, name);
    assert.ok(profile.maxOutputTokens.reply > 0 && profile.maxOutputTokens.extraction > 0, name);
  }
});

test("a hosted profile reads its endpoint and key from the environment", () => {
  const profile = loadModelProfile("azure_luna_low", PROFILES, ENV, configKeys);
  assert.equal(profile.baseUrl, ENV.AZURE_OPENAI_BASE_URL);
  assert.equal(profile.apiKey, "azure-key");
  assert.equal(profile.authHeader, "api-key");
  assert.equal(profile.reasoningEffort, "low");
});

test("the local profile neither reasons nor thinks, and has its own key", () => {
  const profile = loadModelProfile("omlx_gemma4_e4b", PROFILES, ENV, configKeys);
  assert.equal(profile.apiKey, "local-key");
  assert.equal(profile.authHeader, undefined);
  assert.equal(profile.reasoningEffort, undefined);
  assert.equal(profile.thinking, false);
});

const BASE = `base_url: http://local.test/v1
api_key_env: OMLX_API_KEY
model: m
max_output_tokens:
  reply: 600
  extraction: 1024
`;

test("reasoning_effort stops at low: anything higher is the wrong model", () => {
  for (const effort of ["medium", "high"]) {
    const directory = scratch("eager", `${BASE}reasoning_effort: ${effort}\n`);
    assert.throws(
      () => loadModelProfile("eager", directory, ENV, configKeys),
      (error: Error) => error.message.includes("reasoning_effort"),
    );
  }
});

test("a profile may only read keys the config schema declares", () => {
  const directory = scratch("sneaky", BASE.replace("OMLX_API_KEY", "HOME_SECRET"));
  assert.throws(
    () => loadModelProfile("sneaky", directory, { ...ENV, HOME_SECRET: "x" }, configKeys),
    (error: Error) => error.message.includes("HOME_SECRET is not a key the config schema declares"),
  );
});

test("exactly one of base_url and base_url_env", () => {
  const both = scratch("both", `${BASE}base_url_env: AZURE_OPENAI_BASE_URL\n`);
  assert.throws(() => loadModelProfile("both", both, ENV, configKeys), /exactly one of base_url/);
  const neither = scratch("neither", BASE.replace("base_url: http://local.test/v1\n", ""));
  assert.throws(() => loadModelProfile("neither", neither, ENV, configKeys), /exactly one of base_url/);
});

test("an unknown field is refused rather than silently ignored", () => {
  const directory = scratch("typo", `${BASE}reasoning_efort: low\n`);
  assert.throws(() => loadModelProfile("typo", directory, ENV, configKeys), /reasoning_efort|Unrecognized/);
});

test("a name that is not a plain profile name never reaches the filesystem", () => {
  assert.throws(() => loadModelProfile("../secrets", PROFILES, ENV, configKeys), /not a profile name/);
});
