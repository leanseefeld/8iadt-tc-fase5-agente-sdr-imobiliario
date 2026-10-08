import { spawnSync } from "node:child_process";
import pg from "pg";

/**
 * `npm run test:integration` — the database-backed suite, in a database of its own.
 *
 * Why: the suite used to run against the demo database the app and the worker
 * were using. The worker's own sweep answered a test's lead message before the
 * test could ("nothingUnanswered"); tests that failed left leads behind that
 * broke exact counts; one reassigned a seeded lead for good; and a follow-up
 * sweep pinned to 2030 claimed the demo's real attempt. None of that can happen
 * in a database nobody else is connected to.
 *
 * What it does, once per run — not per test, which would multiply the run time
 * by the number of files: drop `<name>_test` (forcing out stale connections),
 * create it, apply the migrations and seed it, then run `node --test` with
 * `DATABASE_URL` pointing at it. Arguments are passed through, so
 *
 *   npm run test:integration -- tests/integration/booking.test.ts
 *
 * runs one file on a fresh database. With none, it runs every test file.
 *
 * **The HTTP tests.** Some tests also call a running app over HTTP (the SSE
 * replay). That app is `app-test` — the same app, on port 3200 and this same
 * database (`docker compose --profile test up -d app-test`). The run **fails**
 * when it isn't answering, so the HTTP half can't be skipped by forgetting to
 * start it. `SKIP_HTTP_TESTS=1` skips it on purpose, and says so.
 *
 * **The model.** Tests run on the local e4b whatever `.env` names (ADR 16): a
 * hosted model's budget is limited, and the demo's `.env` may point at one.
 * `TEST_MODEL_PROFILE` picks another profile for one run, on purpose:
 *
 *   docker compose exec -e TEST_MODEL_PROFILE=omlx_gemma4_12b app npm run test:integration -- <file>
 */

const DEFAULT_FILES = ["tests/integration/*.test.ts", "tests/*.test.ts"];
const TEST_APP_URL = process.env.TEST_APP_URL ?? "http://app-test:3200";
const TEST_APP_WAIT_MS = 120_000;
const TEST_MODEL_PROFILE = process.env.TEST_MODEL_PROFILE ?? "omlx_gemma4_e4b";

/**
 * Waits for the test app to answer on this database, then warms the routes the
 * HTTP tests call: `next dev` compiles a route on its first request, which can
 * take longer than a test's own timeout.
 */
async function waitForTestApp(): Promise<boolean> {
  const deadline = Date.now() + TEST_APP_WAIT_MS;
  while (Date.now() < deadline) {
    const ready = await fetch(`${TEST_APP_URL}/api/health/ready`, { signal: AbortSignal.timeout(20_000) })
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) {
      await fetch(`${TEST_APP_URL}/api/chat/00000000-0000-0000-0000-000000000000/events`, {
        signal: AbortSignal.timeout(60_000),
      }).catch(() => undefined);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

function testUrl(source: string): { url: string; name: string; admin: string } {
  const url = new URL(source);
  const base = url.pathname.replace(/^\//, "");
  const name = base.endsWith("_test") ? base : `${base}_test`;
  const admin = new URL(source);
  admin.pathname = "/postgres";
  url.pathname = `/${name}`;
  return { url: url.toString(), name, admin: admin.toString() };
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): number {
  const result = spawnSync(command, args, { stdio: "inherit", env, cwd: process.cwd() });
  return result.status ?? 1;
}

async function main(): Promise<number> {
  const source = process.env.DATABASE_URL;
  if (!source) {
    console.error("DATABASE_URL is not set; the test database is derived from it.");
    return 1;
  }
  const { url, name, admin } = testUrl(source);
  if (!/^[a-z0-9_]+$/.test(name)) {
    console.error(`refusing to manage a database named ${JSON.stringify(name)}`);
    return 1;
  }

  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  try {
    await client.query(`drop database if exists "${name}" with (force)`);
    await client.query(`create database "${name}"`);
  } finally {
    await client.end();
  }
  console.log(`test database ${name}: created`);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: url,
    INTEGRATION: "1",
    TEST_DATABASE: "1",
    MODEL_PROFILE: TEST_MODEL_PROFILE,
    // A test run's traces are filed apart from the demo's in Langfuse.
    LANGFUSE_TRACING_ENVIRONMENT: "test",
    // Every test process traces its model calls to Langfuse
    // (tests/support/observe.ts). TRACE_TESTS=0 turns it off.
    ...(process.env.TRACE_TESTS === "0"
      ? {}
      : { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${process.cwd()}/tests/support/observe.ts`.trim() }),
  };
  if (run("node", ["src/db/migrate.ts"], env) !== 0) return 1;
  if (run("node", ["src/db/seed/index.ts"], env) !== 0) return 1;
  console.log(`test database ${name}: migrated and seeded`);
  console.log(`model profile: ${TEST_MODEL_PROFILE}`);

  if (process.env.SKIP_HTTP_TESTS === "1") {
    console.log("SKIP_HTTP_TESTS=1: the HTTP tests are skipped on purpose");
  } else if (await waitForTestApp()) {
    env.TEST_APP_URL = TEST_APP_URL;
    console.log(`test app answering at ${TEST_APP_URL}`);
  } else {
    console.error(
      `No test app at ${TEST_APP_URL}. Start it once with:\n\n` +
        "  docker compose --profile test up -d app-test\n\n" +
        "or run without the HTTP tests, on purpose, with SKIP_HTTP_TESTS=1.",
    );
    return 1;
  }

  const files = process.argv.slice(2);
  return run("node", ["--test", "--test-concurrency=1", ...(files.length > 0 ? files : DEFAULT_FILES)], env);
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
