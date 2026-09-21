import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeNotifier } from "../../src/core/notifier.ts";
import { closePool, getPool } from "../../src/db/client.ts";
import { loadTurn } from "../../src/services/conversation.ts";
import { assumeConversation, returnToAgent, sendBrokerReply } from "../../src/services/handoff.ts";
import { turnBriefing } from "../../src/agent/prompts/system.ts";
import { EMPTY_SLOTS } from "../../src/domain/slots.ts";
import type { LeadScope } from "../../src/services/auth.ts";

/**
 * INTEGRATION=1 — what the model is told when a person has spoken in the
 * conversation (decisions of 21/09/2026).
 *
 * The defect this pins down is invisible in any unit test: a broker's message
 * is stored with `role = 'broker'` and was handed to the model as `assistant`,
 * so "Oi, aqui é a Ana" read as the agent introducing itself as Ana. The fix
 * lives in the transcript the prompt is built from, so the transcript is what
 * is asserted here — no model call, just the rows and the strings.
 */
const integration = process.env.INTEGRATION === "1";

async function fixture(): Promise<{ scope: LeadScope; leadId: string; conversationId: string; ana: string }> {
  const pool = getPool();
  const { rows: users } = await pool.query<{ id: string; agency_id: string }>(
    "select id, agency_id from users where email = 'ana@demo.com.br'",
  );
  assert.ok(users[0] !== undefined, "run `npm run db:seed` first");

  const { rows: leadRows } = await pool.query<{ id: string }>(
    `insert into leads (agency_id, channel, external_id, intent, status, name, consent_at)
     values ($1, 'web', $2, 'purchase', 'qualifying', 'Camila de Teste', now()) returning id`,
    [users[0].agency_id, `test-multiparty-${randomUUID()}`],
  );
  const { rows: conversationRows } = await pool.query<{ id: string }>(
    `insert into conversations (agency_id, lead_id, channel, status) values ($1, $2, 'web', 'active') returning id`,
    [users[0].agency_id, leadRows[0].id],
  );
  await pool.query(
    `insert into messages (conversation_id, role, content, created_at) values
       ($1, 'lead', 'Oi, queria um apê de 2 quartos em Moema', now() - interval '10 minutes'),
       ($1, 'agent', 'Legal! Até quanto você pretende investir?', now() - interval '9 minutes')`,
    [conversationRows[0].id],
  );

  return {
    scope: { agencyId: users[0].agency_id, defaultOwnLeadsOnly: true },
    leadId: leadRows[0].id,
    conversationId: conversationRows[0].id,
    ana: users[0].id,
  };
}

test("a broker's turn in the conversation is visible to the agent", {
  skip: !integration,
}, async (t) => {
  const { scope, leadId, conversationId, ana } = await fixture();
  t.after(async () => {
    const pool = getPool();
    await pool.query("delete from events where lead_id = $1", [leadId]);
    await pool.query("delete from messages where conversation_id = $1", [conversationId]);
    await pool.query("delete from conversations where id = $1", [conversationId]);
    await pool.query("delete from leads where id = $1", [leadId]);
    await closeNotifier();
    await closePool();
  });

  await assumeConversation(scope, leadId, ana);
  await sendBrokerReply(scope, leadId, ana, "Oi Camila, aqui é a Ana. Já confirmei sua visita amanhã às 15h!");

  await t.test("the takeover and the author reach the loaded turn", async () => {
    const turn = await loadTurn({ conversationId });
    assert.ok(turn !== null);
    assert.deepEqual(
      turn.handovers.map((handover) => handover.kind),
      ["assumed"],
    );
    assert.equal(turn.handovers[0].name, "Ana", "the first name, not the full one");
    assert.equal(Object.values(turn.brokerNames)[0], "Ana");

    const broker = turn.history.find((message) => message.role === "broker");
    assert.equal(broker?.metadata.userId, ana, "the message names its author");
  });

  await t.test("the briefing tells the model whose words those are", async () => {
    const briefing = turnBriefing({
      intent: "purchase",
      slots: EMPTY_SLOTS,
      filled: [],
      question: null,
      consented: true,
      meeting: null,
      notUnderstood: false,
      broker: { name: "Ana", justReturned: false },
    });

    assert.match(briefing, /\[Ana escreveu\]/, "it explains the label in the transcript");
    assert.match(briefing, /você é a Sofia/i, "and that the agent is still itself");
    assert.match(briefing, /não pergunte de novo/i, "what Ana settled stays settled");
    assert.match(briefing, /ofereça chamar Ana/i, "and the way out is offering Ana back");
    assert.doesNotMatch(briefing, /acabou de devolver/i, "nothing was handed back yet");
  });

  await t.test("a hand-back is announced, and only on the first turn after it", async () => {
    await returnToAgent(scope, leadId, ana);

    const turn = await loadTurn({ conversationId });
    assert.ok(turn !== null);
    assert.deepEqual(
      turn.handovers.map((handover) => handover.kind),
      ["assumed", "returned"],
    );

    const briefing = turnBriefing({
      intent: "purchase",
      slots: EMPTY_SLOTS,
      filled: [],
      question: null,
      consented: true,
      meeting: null,
      notUnderstood: false,
      broker: { name: "Ana", justReturned: true },
    });
    assert.match(briefing, /acabou de devolver a conversa/i);
    assert.match(briefing, /pergunte se pode ajudar em mais alguma coisa/i);
    assert.match(briefing, /sem inventar assunto/i);
  });

  await t.test("a conversation no person touched carries none of it", async () => {
    const briefing = turnBriefing({
      intent: "purchase",
      slots: EMPTY_SLOTS,
      filled: [],
      question: null,
      consented: true,
      meeting: null,
      notUnderstood: false,
    });
    assert.doesNotMatch(briefing, /corretor/i, "the rule is paid for by the turns that need it");
  });
});
