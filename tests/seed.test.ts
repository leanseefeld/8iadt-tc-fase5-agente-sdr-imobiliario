import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getPool, closePool } from "../src/db/client.ts";

/**
 * INTEGRATION=1 — needs a live, migrated Postgres. US2/SC-002: running
 * `npm run db:seed` twice must leave identical counts and bcrypt-only
 * password storage (FR-008, FR-009).
 */
const integration = process.env.INTEGRATION === "1";
const run = promisify(execFile);

async function seedOnce(): Promise<void> {
  await run("node", ["src/db/seed/index.ts"], { cwd: process.cwd() });
}

async function counts() {
  const pool = getPool();
  const [agencies, users, properties, leads] = await Promise.all([
    pool.query("select count(*)::int as n from agencies"),
    pool.query("select count(*)::int as n from users"),
    pool.query("select count(*)::int as n from properties"),
    pool.query("select count(*)::int as n from leads"),
  ]);
  return {
    agencies: agencies.rows[0].n,
    users: users.rows[0].n,
    properties: properties.rows[0].n,
    leads: leads.rows[0].n,
  };
}

test("seeding twice is idempotent (SC-002)", { skip: !integration }, async (t) => {
  await seedOnce();
  const first = await counts();

  await seedOnce();
  const second = await counts();

  assert.deepEqual(second, first);
  assert.deepEqual(first, { agencies: 1, users: 3, properties: 100, leads: 3 });

  await t.test("every password is a bcrypt hash only", async () => {
    const pool = getPool();
    const { rows } = await pool.query<{ password_hash: string }>("select password_hash from users");
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.match(row.password_hash, /^\$2[aby]\$\d{2}\$/);
    }
  });

  await t.test("each demo lead has a conversation, messages and events", async () => {
    const pool = getPool();
    const { rows } = await pool.query<{ external_id: string; messages: string; events: string }>(`
      select l.external_id,
             (select count(*) from messages m where m.conversation_id = c.id) as messages,
             (select count(*) from events e where e.conversation_id = c.id) as events
      from leads l
      join conversations c on c.lead_id = l.id
      order by l.external_id
    `);
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.ok(Number(row.messages) > 0, `${row.external_id} has messages`);
      assert.ok(Number(row.events) > 0, `${row.external_id} has events`);
    }
  });

  await t.after(async () => {
    await closePool();
  });
});
