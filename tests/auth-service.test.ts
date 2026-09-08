import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { newSession, type SessionPayload } from "../src/core/auth.ts";
import { login, reassignLead, scopeForUser } from "../src/services/auth.ts";
import { closePool, getDb } from "../src/db/client.ts";
import { events, leads, users } from "../src/db/schema.ts";

const integration = process.env.INTEGRATION === "1";
const run = promisify(execFile);

// ---------------------------------------------------------------------------
// scopeForUser — pure, no database (FR-011, contracts/scope-for-user.md)
// ---------------------------------------------------------------------------

const agencyId = "22222222-2222-4222-8222-222222222222";

function sessionFor(role: "broker" | "salesManager"): SessionPayload {
  return newSession({ userId: "11111111-1111-4111-8111-111111111111", agencyId, role });
}

test("a broker's scope is the whole agency, listed as their own by default", () => {
  assert.deepEqual(scopeForUser(sessionFor("broker")), {
    agencyId,
    defaultOwnLeadsOnly: true,
  });
});

test("a sales manager's scope is the same agency, listed unfiltered by default", () => {
  assert.deepEqual(scopeForUser(sessionFor("salesManager")), {
    agencyId,
    defaultOwnLeadsOnly: false,
  });
});

// ---------------------------------------------------------------------------
// login and reassignLead — need the seeded users and leads
// ---------------------------------------------------------------------------

test("auth service against the seeded agency", { skip: !integration }, async (t) => {
  await run("node", ["src/db/seed/index.ts"], { cwd: process.cwd() });
  const db = getDb();

  const seeded = await db
    .select({ id: users.id, email: users.email, agencyId: users.agencyId, role: users.role })
    .from(users);
  const ana = seeded.find((u) => u.email === "ana@demo.com.br")!;
  const bruno = seeded.find((u) => u.email === "bruno@demo.com.br")!;
  const carla = seeded.find((u) => u.email === "carla@demo.com.br")!;
  assert.ok(ana && bruno && carla, "expected the three seeded users");

  await t.test("correct credentials produce a session carrying the user's agency and role", async () => {
    const session = await login("ana@demo.com.br", "demo1234", "10.0.0.1");
    assert.ok(session);
    assert.equal(session.userId, ana.id);
    assert.equal(session.agencyId, ana.agencyId);
    assert.equal(session.role, "broker");
  });

  await t.test("the manager's session carries the salesManager role", async () => {
    const session = await login("carla@demo.com.br", "demo1234", "10.0.0.1");
    assert.equal(session?.role, "salesManager");
  });

  await t.test("e-mail is matched case-insensitively and trimmed", async () => {
    assert.ok(await login("  Ana@Demo.com.BR  ", "demo1234", "10.0.0.1"));
  });

  await t.test("a wrong password, an unknown e-mail and empty input are one outcome", async () => {
    assert.equal(await login("ana@demo.com.br", "wrong-password", "10.0.0.1"), null);
    assert.equal(await login("ninguem@demo.com.br", "demo1234", "10.0.0.1"), null);
    assert.equal(await login("", "", "10.0.0.1"), null);
  });

  await t.test("scoping returns every lead of the agency for both roles (SC-004)", async () => {
    const asBroker = scopeForUser(newSession({ userId: ana.id, agencyId: ana.agencyId, role: "broker" }));
    const asManager = scopeForUser(
      newSession({ userId: carla.id, agencyId: carla.agencyId, role: "salesManager" }),
    );

    const brokerLeads = await db
      .select({ id: leads.id })
      .from(leads)
      .where(eq(leads.agencyId, asBroker.agencyId));
    const managerLeads = await db
      .select({ id: leads.id })
      .from(leads)
      .where(eq(leads.agencyId, asManager.agencyId));

    assert.ok(brokerLeads.length > 0, "expected the seeded demo leads");
    assert.deepEqual(
      brokerLeads.map((l) => l.id).sort(),
      managerLeads.map((l) => l.id).sort(),
      "a broker and a manager see the same leads",
    );
    assert.equal(asBroker.defaultOwnLeadsOnly, true);
    assert.equal(asManager.defaultOwnLeadsOnly, false);
  });

  const [firstLead] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(eq(leads.agencyId, ana.agencyId));

  const eventsFor = (leadId: string) =>
    db
      .select({ id: events.id, actorUserId: events.actorUserId, payload: events.payload })
      .from(events)
      .where(and(eq(events.leadId, leadId), eq(events.type, "lead.reassigned")));

  await t.test("a broker's reassignment is refused, with no effect and no event", async () => {
    const before = await eventsFor(firstLead.id);
    await assert.rejects(
      reassignLead(newSession({ userId: ana.id, agencyId: ana.agencyId, role: "broker" }), firstLead.id, bruno.id),
      /salesManager/,
    );
    assert.equal((await eventsFor(firstLead.id)).length, before.length);
  });

  await t.test("a manager reassigns the lead and the service records the event", async () => {
    const manager = newSession({ userId: carla.id, agencyId: carla.agencyId, role: "salesManager" });
    const [before] = await db
      .select({ assignedBrokerId: leads.assignedBrokerId })
      .from(leads)
      .where(eq(leads.id, firstLead.id));

    await reassignLead(manager, firstLead.id, bruno.id);

    const [after] = await db
      .select({ assignedBrokerId: leads.assignedBrokerId })
      .from(leads)
      .where(eq(leads.id, firstLead.id));
    assert.equal(after.assignedBrokerId, bruno.id);

    const recorded = await eventsFor(firstLead.id);
    const latest = recorded[recorded.length - 1];
    assert.equal(latest.actorUserId, carla.id);
    assert.deepEqual(latest.payload, {
      fromBrokerId: before.assignedBrokerId,
      toBrokerId: bruno.id,
    });
  });

  await t.test("a target who is not a broker of this agency is refused", async () => {
    const manager = newSession({ userId: carla.id, agencyId: carla.agencyId, role: "salesManager" });
    await assert.rejects(reassignLead(manager, firstLead.id, carla.id), /broker of this agency/);
    await assert.rejects(
      reassignLead(manager, firstLead.id, "33333333-3333-4333-8333-333333333333"),
      /broker of this agency/,
    );
  });

  await t.test("a lead outside the session's agency is invisible, not an update", async () => {
    const foreign = newSession({ userId: carla.id, agencyId, role: "salesManager" });
    await assert.rejects(reassignLead(foreign, firstLead.id, bruno.id), /broker of this agency/);
  });

  await closePool();
});
