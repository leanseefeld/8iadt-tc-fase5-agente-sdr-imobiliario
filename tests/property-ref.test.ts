import test from "node:test";
import assert from "node:assert/strict";
import { closePool, getPool } from "../src/db/client.ts";
import { resolvePropertyRef, type LoadedTurn, type TurnMessage } from "../src/services/conversation.ts";

/**
 * FR-004b — "o segundo" or "VMA-0005" resolves only among the properties this
 * conversation has already shown. Anything else is ignored, never guessed. The
 * cases that reach the catalog run with INTEGRATION=1 against the demo agency.
 */
const integration = process.env.INTEGRATION === "1";

function agentMessage(metadata: Record<string, unknown>): TurnMessage {
  return { id: crypto.randomUUID(), role: "agent", content: "", repliesToMessageId: null, metadata, createdAt: new Date() };
}

function turnWith(agencyId: string, history: TurnMessage[]): LoadedTurn {
  return { agency: { id: agencyId, slug: "demo" }, history } as unknown as LoadedTurn;
}

test("with no cards shown, neither a position nor a code resolves", async () => {
  const turn = turnWith(crypto.randomUUID(), [agentMessage({}), agentMessage({ meeting: "viewing" })]);
  assert.equal(await resolvePropertyRef(turn, { position: 1 }), null);
  assert.equal(await resolvePropertyRef(turn, { code: "VMA-0005" }), null);
});

test("positions count in the latest cards; codes in any card shown so far", { skip: !integration }, async (t) => {
  t.after(closePool);
  const rows = (
    await getPool().query(
      `select p.id, p.code, p.agency_id from properties p join agencies a on a.id = p.agency_id
        where a.slug = 'demo' order by p.code limit 5`,
    )
  ).rows as { id: string; code: string; agency_id: string }[];
  assert.equal(rows.length, 5, "the demo seed has properties");
  const [a, b, c, d, never] = rows;
  const turn = turnWith(a.agency_id, [
    agentMessage({ propertyIds: [a.id, b.id] }),
    agentMessage({}),
    agentMessage({ propertyIds: [c.id, d.id] }),
  ]);

  assert.deepEqual(await resolvePropertyRef(turn, { position: 2 }), { id: d.id, code: d.code }, "latest cards");
  assert.equal(await resolvePropertyRef(turn, { position: 3 }), null, "past the end of the latest cards");
  assert.deepEqual(
    await resolvePropertyRef(turn, { code: a.code.toLowerCase() }),
    { id: a.id, code: a.code },
    "an earlier card, any case",
  );
  assert.equal(await resolvePropertyRef(turn, { code: never.code }), null, "in the catalog but never shown");
  assert.equal(await resolvePropertyRef(turnWith(crypto.randomUUID(), turn.history), { code: a.code }), null, "another agency");
});
