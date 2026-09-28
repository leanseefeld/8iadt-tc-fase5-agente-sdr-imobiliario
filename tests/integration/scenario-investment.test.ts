import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closePool, getPool } from "../../src/db/client.ts";
import { collectingSink, runTurn, type TurnResult } from "../../src/agent/orchestrator.ts";
import { recordLeadMessage } from "../../src/services/conversation.ts";
import { splitSentences } from "../../src/domain/reply-guards.ts";
import { qualifyingSlots } from "../../src/domain/slots.ts";

/**
 * INTEGRATION=1 — Cenário 2.1 of `reference/exemplos de conversas.md`, the
 * first-time investor, end to end against the local model (T055).
 *
 * Asserts SC-002 (the investment script fills and the lead qualifies), SC-003,
 * and the two things that make this scenario different from Cenário 1: the
 * catalog is **never** consulted for an investor (FR-024), and the meeting
 * proposed is a call with a specialist rather than a viewing (FR-041).
 *
 * Slow by design. Cleans up its own rows.
 */
const integration = process.env.INTEGRATION === "1";

const AGENCY = "demo";

const SCRIPT = [
  "Quero investir em imóveis para renda",
  "Seria o primeiro, hoje só tenho tesouro direto e ações",
  "Algo em torno de 350 mil",
  "Renda mensal mesmo, quero complementar minha aposentadoria",
  "Meu nome é Rafael Souza",
  "Meu e-mail é rafael@example.com",
] as const;

interface Row {
  [column: string]: unknown;
}

async function query(sql: string, params: unknown[] = []): Promise<Row[]> {
  const result = await getPool().query(sql, params);
  return result.rows as Row[];
}

test("Cenário 2 runs end to end (SC-002, SC-003)", { skip: !integration }, async (t) => {
  const sessionId = `test-${randomUUID()}`;
  const turns: TurnResult[] = [];
  let conversationId = "";
  let leadId = "";

  for (const text of SCRIPT) {
    const inbound = await recordLeadMessage({
      agencySlug: AGENCY,
      externalId: sessionId,
      clientMessageId: randomUUID(),
      text,
      consent: true,
    });
    assert.equal(inbound.status, "stored", `${text}: ${JSON.stringify(inbound)}`);
    assert.ok("conversationId" in inbound);
    conversationId = inbound.conversationId;
    leadId = inbound.leadId;

    const result = await runTurn({ conversationId, sink: collectingSink() });
    assert.equal(result.status, "committed", `${text}: ${JSON.stringify(result)}`);
    turns.push(result);
  }

  const committed = turns.filter((turn) => turn.status === "committed");
  const last = committed.at(-1);
  assert.ok(last !== undefined && last.status === "committed");

  await t.test("the investment script is filled and the lead is qualified (SC-002)", () => {
    assert.equal(last.intent, "investment");
    for (const slot of qualifyingSlots("investment")) {
      assert.notEqual(
        last.slots[slot],
        null,
        `${slot} is still empty: ${JSON.stringify(last.slots)}`,
      );
    }
    assert.equal(last.qualified, true);
  });

  await t.test("one question per message, none of them repeated (SC-003)", () => {
    for (const turn of committed) {
      assert.ok(turn.status === "committed");
      const questions = splitSentences(turn.reply).filter((sentence) => sentence.includes("?"));
      assert.ok(questions.length <= 2, `${questions.length} questions in: ${turn.reply}`);

      const slot = turn.question?.slot;
      if (slot === undefined || slot === "intent") continue;
      assert.equal(
        turn.slots[slot],
        null,
        `${slot} was asked although it already held ${JSON.stringify(turn.slots[slot])}`,
      );
    }
  });

  await t.test("the catalog is never consulted for an investor (FR-024)", async () => {
    for (const turn of committed) {
      assert.ok(turn.status === "committed");
      assert.deepEqual(turn.propertyCodes, [], `cards were shown: ${turn.propertyCodes.join()}`);
    }

    const rows = await query(
      "select type from events where conversation_id = $1 and type = 'properties.suggested'",
      [conversationId],
    );
    assert.equal(rows.length, 0, "a properties.suggested event exists for an investment lead");
  });

  await t.test("the meeting offered is a call with a specialist (FR-041)", async () => {
    assert.equal(last.meeting, "call", `meeting was ${String(last.meeting)}`);
    assert.equal(last.handoffReason, null, "proposing a call is not a handoff (ADR 19)");

    const [row] = await query("select status from conversations where id = $1", [conversationId]);
    assert.equal(row.status, "active");
  });

  t.after(async () => {
    await query("delete from events where conversation_id = $1", [conversationId]);
    // Spec 006: the offer is now a proposed appointment row.
    await query("delete from appointments where conversation_id = $1", [conversationId]);
    await query("delete from messages where conversation_id = $1", [conversationId]);
    await query("delete from followup_jobs where conversation_id = $1", [conversationId]);
    await query("delete from conversations where id = $1", [conversationId]);
    await query("delete from leads where id = $1", [leadId]);
    await closePool();
  });
});
