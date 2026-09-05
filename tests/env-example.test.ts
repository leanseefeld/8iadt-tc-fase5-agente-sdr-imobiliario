import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configKeys } from "../src/core/config.ts";

/**
 * The Environment Contract gate.
 *
 * A variable read but undocumented breaks a clean clone. A variable documented
 * but unread is stale configuration that misleads the next reader. Both are
 * failures, so this asserts set equality rather than containment.
 */
const examplePath = fileURLToPath(new URL("../.env.example", import.meta.url));

function keysDefinedIn(contents: string): string[] {
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.split("=")[0].trim())
    .filter((key) => key !== "");
}

test(".env.example and the config schema declare the same keys", () => {
  const documented = new Set(keysDefinedIn(readFileSync(examplePath, "utf8")));
  const declared = new Set(configKeys);

  const undocumented = [...declared].filter((key) => !documented.has(key)).sort();
  const unread = [...documented].filter((key) => !declared.has(key)).sort();

  assert.deepEqual(
    undocumented,
    [],
    `read by the schema but missing from .env.example: ${undocumented.join(", ")}`,
  );
  assert.deepEqual(
    unread,
    [],
    `documented in .env.example but unknown to the schema: ${unread.join(", ")}`,
  );
});

test(".env.example defines no key twice", () => {
  const keys = keysDefinedIn(readFileSync(examplePath, "utf8"));
  assert.equal(new Set(keys).size, keys.length, "duplicate key in .env.example");
});
