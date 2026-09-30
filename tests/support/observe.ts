import { basename } from "node:path";
import { forgetConfig } from "../../src/core/config.ts";
import { flushLangfuse, registerLangfuse } from "../../src/core/langfuse.ts";

/**
 * Preloaded into every test process by `npm run test:integration` (see
 * `src/db/test-db.ts`): the model calls a test makes are traced to Langfuse
 * like the app's, in the `test` environment, with the test file as the
 * service — which file, which call, how long, which model. With no Langfuse
 * keys this does nothing.
 *
 * Only a process `node --test` spawned for one file registers; the parent,
 * which runs none, doesn't.
 */
const file = process.argv.slice(1).find((arg) => /\/tests\/.*\.ts$/.test(arg));
if (process.env.NODE_TEST_CONTEXT !== undefined && file !== undefined) {
  await registerLangfuse("worker", `test:${basename(file).replace(/\.ts$/, "")}`);
  // Registering read the config; a test that sets its own environment first
  // (provider-outage points at a dead provider) must still be the one it reads.
  forgetConfig();
  let flushed = false;
  process.on("beforeExit", () => {
    if (flushed) return;
    flushed = true;
    void flushLangfuse(10_000);
  });
}
