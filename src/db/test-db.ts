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
 * `TEST_DATABASE=1` tells the few tests that also talk to the running app over
 * HTTP that the app is on another database, so they skip that half.
 */

const DEFAULT_FILES = ["tests/integration/*.test.ts", "tests/*.test.ts"];

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

  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url, INTEGRATION: "1", TEST_DATABASE: "1" };
  if (run("node", ["src/db/migrate.ts"], env) !== 0) return 1;
  if (run("node", ["src/db/seed/index.ts"], env) !== 0) return 1;
  console.log(`test database ${name}: migrated and seeded`);

  const files = process.argv.slice(2);
  return run("node", ["--test", "--test-concurrency=1", ...(files.length > 0 ? files : DEFAULT_FILES)], env);
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
