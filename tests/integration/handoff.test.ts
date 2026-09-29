import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closePool, getPool } from "../../src/db/client.ts";
import { closeNotifier } from "../../src/core/notifier.ts";
import {
  assumeConversation,
  returnToAgent,
  sendBrokerReply,
  setLeadStatus,
} from "../../src/services/handoff.ts";
import { getLeadDetail } from "../../src/services/leads.ts";
import type { LeadScope } from "../../src/services/auth.ts";

/**
 * INTEGRATION=1 — the takeover rules against Postgres (FR-032 to FR-037).
 *
 * The case worth a database is the collision: two brokers assuming the same
 * conversation. A read-then-write passes both, so the precondition lives in the
 * `where` clause, and this is what proves it. Everything else — the stage table,
 * the reply gate — is here because it shares the fixture.
 *
 * It builds its own lead and removes it afterwards, so the demo rows stay as the
 * demo left them.
 */
const integration = process.env.INTEGRATION === "1";

interface Fixture {
  scope: LeadScope;
  leadId: string;
  conversationId: string;
  ana: string;
  bruno: string;
}

async function fixture(): Promise<Fixture> {
  const pool = getPool();
  const { rows: users } = await pool.query<{ id: string; email: string; agency_id: string }>(
    "select id, email, agency_id from users where email in ('ana@demo.com.br','bruno@demo.com.br')",
  );
  const ana = users.find((row) => row.email === "ana@demo.com.br");
  const bruno = users.find((row) => row.email === "bruno@demo.com.br");
  assert.ok(ana !== undefined && bruno !== undefined, "run `npm run db:seed` first");

  const externalId = `test-handoff-${randomUUID()}`;
  const { rows: leadRows } = await pool.query<{ id: string }>(
    `insert into leads (agency_id, channel, external_id, intent, status, score, name)
     values ($1, 'web', $2, 'purchase', 'new', 40, 'Lead de Teste') returning id`,
    [ana.agency_id, externalId],
  );
  const { rows: conversationRows } = await pool.query<{ id: string }>(
    `insert into conversations (agency_id, lead_id, channel, status)
     values ($1, $2, 'web', 'active') returning id`,
    [ana.agency_id, leadRows[0].id],
  );

  return {
    scope: { agencyId: ana.agency_id, defaultOwnLeadsOnly: true },
    leadId: leadRows[0].id,
    conversationId: conversationRows[0].id,
    ana: ana.id,
    bruno: bruno.id,
  };
}

async function cleanup(leadId: string, conversationId: string): Promise<void> {
  const pool = getPool();
  await pool.query("delete from events where lead_id = $1", [leadId]);
  await pool.query("delete from messages where conversation_id = $1", [conversationId]);
  await pool.query("delete from appointments where conversation_id = $1", [conversationId]);
  await pool.query("delete from followup_jobs where conversation_id = $1", [conversationId]);
  await pool.query("delete from conversations where id = $1", [conversationId]);
  await pool.query("delete from leads where id = $1", [leadId]);
}

test("a takeover is a conditional update, so the second broker loses", {
  skip: !integration,
}, async (t) => {
  const { scope, leadId, conversationId, ana, bruno } = await fixture();
  t.after(async () => {
    await cleanup(leadId, conversationId);
    // Every write here publishes on `conversation_state`, which opens the
    // notifier's own LISTEN connection. It is held for the life of the process
    // by design, so a test that does not close it never exits.
    await closeNotifier();
    await closePool();
  });

  await t.test("assuming pauses the conversation and assigns an unassigned lead", async () => {
    assert.deepEqual(await assumeConversation(scope, leadId, ana), { ok: true });

    const detail = await getLeadDetail(scope, leadId);
    assert.ok(detail !== null);
    assert.equal(detail.conversation.status, "paused");
    assert.equal(detail.conversation.heldByUserId, ana);
    assert.equal(detail.conversation.state.kind, "held");
    assert.equal(detail.assignedBrokerId, ana, "an unassigned lead follows whoever assumed it");
    assert.ok(detail.events.some((event) => event.type === "conversation.assumed"));
  });

  await t.test("a second broker is refused rather than stealing it", async () => {
    const second = await assumeConversation(scope, leadId, bruno);
    assert.equal(second.ok, false);
    assert.ok(second.ok === false && second.message.includes("assumiu"));

    const detail = await getLeadDetail(scope, leadId);
    assert.equal(detail?.conversation.heldByUserId, ana, "the holder did not change");
    assert.equal(detail?.assignedBrokerId, ana, "and neither did the assignment");
  });

  await t.test("only the holder may reply", async () => {
    const theirs = await sendBrokerReply(scope, leadId, bruno, "Oi!");
    assert.equal(theirs.ok, false);

    assert.deepEqual(await sendBrokerReply(scope, leadId, ana, "  Oi, sou a Ana.  "), { ok: true });
    assert.equal((await sendBrokerReply(scope, leadId, ana, "   ")).ok, false, "empty is refused");

    const detail = await getLeadDetail(scope, leadId);
    const written = detail?.messages.at(-1);
    assert.equal(written?.role, "broker");
    assert.equal(written?.content, "Oi, sou a Ana.");
    assert.equal(written?.authorName, "Ana Ribeiro", "the transcript names the person");
    assert.ok(
      detail?.events.some((event) => event.type === "conversation.turn"),
      "a broker reply is a turn, so the summariser sees it",
    );
  });

  await t.test("only the holder may hand back, and then the agent has it again", async () => {
    assert.equal((await returnToAgent(scope, leadId, bruno)).ok, false);
    assert.deepEqual(await returnToAgent(scope, leadId, ana), { ok: true });

    const detail = await getLeadDetail(scope, leadId);
    assert.equal(detail?.conversation.status, "active");
    assert.equal(detail?.conversation.heldByUserId, null);
    assert.equal(detail?.conversation.state.kind, "agent");
    assert.ok(detail?.events.some((event) => event.type === "conversation.returned"));
  });

  await t.test("a replier who holds nothing is told to assume first", async () => {
    const result = await sendBrokerReply(scope, leadId, ana, "Alô?");
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.message.includes("Assuma"));
  });

  await t.test("the stage moves forward, never back, and outcomes are always reachable", async () => {
    assert.deepEqual(await setLeadStatus(scope, leadId, ana, "qualified"), { ok: true });
    assert.equal((await setLeadStatus(scope, leadId, ana, "qualifying")).ok, false);
    assert.equal((await setLeadStatus(scope, leadId, ana, "qualified")).ok, false, "no-op refused");
    assert.equal((await setLeadStatus(scope, leadId, ana, "handoff")).ok, false, "unknown stage");
    assert.deepEqual(await setLeadStatus(scope, leadId, ana, "lost"), { ok: true });

    const detail = await getLeadDetail(scope, leadId);
    assert.equal(detail?.stage, "lost");
    const changes = detail?.events.filter((event) => event.type === "lead.status_changed") ?? [];
    assert.equal(changes.length, 2);
    assert.equal(changes[0].actorType, "user");
    assert.equal(changes[0].actorName, "Ana Ribeiro");
  });

  await t.test("another agency cannot touch any of it", async () => {
    const stranger: LeadScope = { agencyId: randomUUID(), defaultOwnLeadsOnly: false };
    assert.equal((await assumeConversation(stranger, leadId, ana)).ok, false);
    assert.equal((await setLeadStatus(stranger, leadId, ana, "won")).ok, false);
    assert.equal((await sendBrokerReply(stranger, leadId, ana, "oi")).ok, false);
  });
});
