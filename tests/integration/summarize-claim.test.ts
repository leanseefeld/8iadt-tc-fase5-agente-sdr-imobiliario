import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeNotifier } from "../../src/core/notifier.ts";
import { createLogger } from "../../src/core/logging.ts";
import { closePool, getDb, getPool } from "../../src/db/client.ts";
import { summarize } from "../../src/jobs/summarize.ts";
import { useScriptedModel } from "../support/scripted-model.ts";

/**
 * INTEGRATION=1 — the outbox half of the summariser (FR-008 to FR-010).
 *
 * Two of the three cases here need no model at all, which is the point: the
 * debounce and the claim are SQL, and SQL is where they can be proven. The
 * third spends one model call to show that many pending turns collapse into one
 * summary.
 *
 * The concurrency case does not race two workers and hope — it takes the lock a
 * second worker would be holding, and asserts the consumer walks away. A race
 * that passes by timing is a test that fails by timing later.
 */
const integration = process.env.INTEGRATION === "1";
// The pipeline is under test here, not the sampler: the model is scripted.
if (integration) useScriptedModel();
const log = createLogger("worker", { module: "test" });

interface Fixture {
  agencyId: string;
  leadId: string;
  conversationId: string;
}

/** A conversation with `turns` unprocessed turn events, aged `minutesAgo`. */
async function fixture(turns: number, minutesAgo: number): Promise<Fixture> {
  const pool = getPool();
  const { rows: agencies } = await pool.query<{ id: string }>("select id from agencies limit 1");
  assert.ok(agencies[0] !== undefined, "run `npm run db:seed` first");
  const agencyId = agencies[0].id;

  const { rows: leadRows } = await pool.query<{ id: string }>(
    `insert into leads (agency_id, channel, external_id, intent, status, name)
     values ($1, 'web', $2, 'rental', 'qualifying', 'Lead de Teste') returning id`,
    [agencyId, `test-summary-${randomUUID()}`],
  );
  const { rows: conversationRows } = await pool.query<{ id: string }>(
    `insert into conversations (agency_id, lead_id, channel, status)
     values ($1, $2, 'web', 'active') returning id`,
    [agencyId, leadRows[0].id],
  );
  const conversationId = conversationRows[0].id;

  for (let index = 0; index < turns; index += 1) {
    const { rows: messageRows } = await pool.query<{ id: string }>(
      `insert into messages (conversation_id, role, content, created_at)
       values ($1, $2, $3, now() - make_interval(mins => $4)) returning id`,
      [
        conversationId,
        index % 2 === 0 ? "lead" : "agent",
        index % 2 === 0 ? "Quero alugar um apartamento de 2 quartos" : "Claro! Em qual bairro?",
        minutesAgo,
      ],
    );
    await pool.query(
      `insert into events (agency_id, lead_id, conversation_id, type, actor_type, payload, created_at)
       values ($1, $2, $3, 'conversation.turn', 'agent', $4, now() - make_interval(mins => $5))`,
      [agencyId, leadRows[0].id, conversationId, { messageId: messageRows[0].id }, minutesAgo],
    );
  }

  return { agencyId, leadId: leadRows[0].id, conversationId };
}

async function cleanup({ leadId, conversationId }: Fixture): Promise<void> {
  const pool = getPool();
  await pool.query("delete from events where lead_id = $1 or conversation_id = $2", [
    leadId,
    conversationId,
  ]);
  await pool.query("delete from messages where conversation_id = $1", [conversationId]);
  await pool.query("delete from appointments where conversation_id = $1", [conversationId]);
  await pool.query("delete from followup_jobs where conversation_id = $1", [conversationId]);
  await pool.query("delete from conversations where id = $1", [conversationId]);
  await pool.query("delete from leads where id = $1", [leadId]);
}

async function pendingTurns(conversationId: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `select count(*) from events
      where conversation_id = $1 and type = 'conversation.turn' and processed_at is null`,
    [conversationId],
  );
  return Number(rows[0].count);
}

async function summaryCount(conversationId: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    "select count(*) from events where conversation_id = $1 and type = 'summary.updated'",
    [conversationId],
  );
  return Number(rows[0].count);
}

test("a conversation that is still moving is left for the next sweep", {
  skip: !integration,
}, async (t) => {
  const made = await fixture(1, 0);
  t.after(async () => {
    await cleanup(made);
    await closeNotifier();
    await closePool();
  });

  await summarize.run({ db: getDb(), now: new Date(), log });

  assert.equal(await pendingTurns(made.conversationId), 1, "the turn is untouched");
  assert.equal(await summaryCount(made.conversationId), 0, "and no summary was written");
});

test("rows another worker holds are skipped, not waited for", {
  skip: !integration,
}, async (t) => {
  const made = await fixture(2, 30);
  const rival = await getPool().connect();
  t.after(async () => {
    rival.release();
    await cleanup(made);
    await closeNotifier();
    await closePool();
  });

  // Exactly what a second worker's claim does, held open across the sweep.
  await rival.query("begin");
  const held = await rival.query(
    `select id from events
      where conversation_id = $1 and type = 'conversation.turn' and processed_at is null
      for update skip locked`,
    [made.conversationId],
  );
  assert.equal(held.rowCount, 2, "the rival holds both turns");

  await summarize.run({ db: getDb(), now: new Date(), log });

  assert.equal(await summaryCount(made.conversationId), 0, "the sweep produced nothing");
  await rival.query("rollback");
  assert.equal(await pendingTurns(made.conversationId), 2, "and left the turns for its owner");
});

test("many pending turns produce exactly one summary", {
  skip: !integration,
}, async (t) => {
  const made = await fixture(4, 30);
  t.after(async () => {
    await cleanup(made);
    await closeNotifier();
    await closePool();
  });

  await summarize.run({ db: getDb(), now: new Date(), log });

  assert.equal(await summaryCount(made.conversationId), 1, "one summary for four turns");
  assert.equal(await pendingTurns(made.conversationId), 0, "every turn marked handled");

  const { rows } = await getPool().query<{ summary: string; preview_line: string }>(
    "select summary, preview_line from conversations where id = $1",
    [made.conversationId],
  );
  assert.ok(rows[0].summary.length > 0);
  assert.ok(rows[0].preview_line.length > 0 && rows[0].preview_line.length <= 90);

  // A second sweep with nothing new must not spend another model call.
  await summarize.run({ db: getDb(), now: new Date(), log });
  assert.equal(await summaryCount(made.conversationId), 1, "and the next sweep is a no-op");
});
