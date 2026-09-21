import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closePool, getPool } from "../../src/db/client.ts";
import { getLeadDetail, listAgencyBrokers, listLeads } from "../../src/services/leads.ts";
import { getFunnelMetrics } from "../../src/services/metrics.ts";
import type { LeadScope } from "../../src/services/auth.ts";

/**
 * INTEGRATION=1 — the scoping rules of FR-019 against the seeded agency.
 *
 * The claim under test is the one a pasted URL attacks: `agencyId` is applied in
 * SQL by every read, and *Meus leads* is a filter **on top of** that scope, never
 * a replacement for it. The negative halves matter most — another agency sees
 * nothing, and a broker with the toggle on cannot reach a colleague's lead by id.
 *
 * Reads only. It writes nothing, so it leaves the demo database as it found it.
 */
const integration = process.env.INTEGRATION === "1";

async function seededIds(): Promise<{ agencyId: string; ana: string; bruno: string }> {
  const { rows } = await getPool().query<{ id: string; email: string; agency_id: string }>(
    "select id, email, agency_id from users where email in ('ana@demo.com.br','bruno@demo.com.br')",
  );
  const ana = rows.find((row) => row.email === "ana@demo.com.br");
  const bruno = rows.find((row) => row.email === "bruno@demo.com.br");
  assert.ok(ana !== undefined && bruno !== undefined, "run `npm run db:seed` first");
  return { agencyId: ana.agency_id, ana: ana.id, bruno: bruno.id };
}

test("the leads queue is scoped by agency and filtered by Meus leads", {
  skip: !integration,
}, async (t) => {
  const { agencyId, ana, bruno } = await seededIds();
  const scope: LeadScope = { agencyId, defaultOwnLeadsOnly: true };
  t.after(async () => {
    await closePool();
  });

  await t.test("with the toggle off, a broker sees the whole agency", async () => {
    const list = await listLeads(scope, { filter: "todos", mine: false, userId: ana, page: 1 });
    assert.equal(list.total, 3);
    assert.equal(list.rows.length, 3);
  });

  await t.test("with the toggle on, a broker sees only their own leads", async () => {
    const mine = await listLeads(scope, { filter: "todos", mine: true, userId: ana, page: 1 });
    assert.equal(mine.total, 2);
    const theirs = await listLeads(scope, { filter: "todos", mine: true, userId: bruno, page: 1 });
    assert.equal(theirs.total, 1);
    assert.equal(theirs.rows[0].name, "Rafael Souza");
  });

  await t.test("the toggle applies to search too", async () => {
    const hidden = await listLeads(scope, {
      filter: "todos",
      mine: true,
      userId: ana,
      search: "Rafael",
      page: 1,
    });
    assert.equal(hidden.total, 0);

    const found = await listLeads(scope, {
      filter: "todos",
      mine: false,
      userId: ana,
      search: "rafael",
      page: 1,
    });
    assert.equal(found.total, 1, "search is case-insensitive");
  });

  await t.test("rows are ordered by score descending", async () => {
    const list = await listLeads(scope, { filter: "todos", mine: false, userId: ana, page: 1 });
    const scores = list.rows.map((row) => row.score);
    assert.deepEqual([...scores].sort((a, b) => b - a), scores);
    assert.equal(list.rows[0].temperature, "hot");
  });

  await t.test("the reassignment roster is the agency's brokers, by name", async () => {
    const roster = await listAgencyBrokers(scope);
    assert.deepEqual(
      roster.map((broker) => broker.name),
      ["Ana Ribeiro", "Bruno Castro"],
      "the sales manager is not a target, and the order is alphabetical",
    );
    assert.deepEqual(
      await listAgencyBrokers({ agencyId: randomUUID(), defaultOwnLeadsOnly: false }),
      [],
    );
  });

  await t.test("another agency sees nothing at all", async () => {
    const stranger: LeadScope = { agencyId: randomUUID(), defaultOwnLeadsOnly: false };
    const list = await listLeads(stranger, { filter: "todos", mine: false, userId: ana, page: 1 });
    assert.equal(list.total, 0);
  });

  await t.test("a lead outside the scope reads as not found, by id", async () => {
    const all = await listLeads(scope, { filter: "todos", mine: false, userId: ana, page: 1 });
    const someLead = all.rows[0].id;

    const stranger: LeadScope = { agencyId: randomUUID(), defaultOwnLeadsOnly: false };
    assert.equal(await getLeadDetail(stranger, someLead), null);
    assert.equal(await getLeadDetail(scope, randomUUID()), null);
  });

  await t.test("the panel carries the whole conversation and its trail", async () => {
    const mine = await listLeads(scope, { filter: "todos", mine: true, userId: ana, page: 1 });
    const detail = await getLeadDetail(scope, mine.rows[0].id);
    assert.ok(detail !== null);
    assert.ok(detail.messages.length >= 4);
    assert.ok(detail.events.length >= 4);
    assert.equal(detail.assignedBrokerName, "Ana Ribeiro");
    assert.equal(detail.conversation.state.kind, "agent");
  });

  await t.test("the filters read the three state axes, not the funnel", async () => {
    const waiting = await listLeads(scope, {
      filter: "aguardando",
      mine: false,
      userId: ana,
      page: 1,
    });
    assert.equal(waiting.total, 0, "nothing is paused in the seed");

    const scheduled = await listLeads(scope, {
      filter: "visita_marcada",
      mine: false,
      userId: ana,
      page: 1,
    });
    assert.equal(scheduled.total, 1);
    assert.equal(scheduled.rows[0].name, "Camila Andrade");
  });
});

test("the funnel metrics read the agency and nothing else", {
  skip: !integration,
}, async (t) => {
  const { agencyId } = await seededIds();
  t.after(async () => {
    await closePool();
  });

  const metrics = await getFunnelMetrics({ agencyId, defaultOwnLeadsOnly: false });
  assert.equal(metrics.totalLeads, 3);
  assert.equal(metrics.qualifiedLeads, 1, "only the scheduled lead is at qualified or beyond");
  assert.ok(metrics.qualificationRate !== null && Math.abs(metrics.qualificationRate - 1 / 3) < 1e-9);
  assert.equal(metrics.confirmedAppointments, 1);
  assert.equal(metrics.recoveredLeads, 0, "spec 006 has not landed");
  assert.ok(
    metrics.medianFirstResponseSeconds !== null && metrics.medianFirstResponseSeconds > 0,
    "the seed answers every demo lead",
  );

  const stranger = await getFunnelMetrics({ agencyId: randomUUID(), defaultOwnLeadsOnly: false });
  assert.equal(stranger.totalLeads, 0);
  assert.equal(stranger.qualificationRate, null, "no leads is not a rate of zero");
});
