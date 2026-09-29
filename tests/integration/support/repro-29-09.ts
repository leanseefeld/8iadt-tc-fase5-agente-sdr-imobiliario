import test from "node:test";
import { closePool } from "../../../src/db/client.ts";
import { bookDirect, nextLocal, qualifiedLead, query, type Lead } from "./meeting.ts";

/**
 * Diagnostic, not a test: replays the developer's phone conversations of
 * 29/09/2026 on the test database, word for word, and prints each turn with
 * the facts the extraction read. Run it on e4b and on 12B to tell a model
 * limit from a code path:
 *
 *   npm run test:integration -- tests/integration/support/repro-29-09.ts
 *   docker compose exec -e MODEL_ID=gemma-4-12B-it-OptiQ-4bit app npm run test:integration -- tests/integration/support/repro-29-09.ts
 *
 * It asserts nothing; the transcript is the output.
 */

const DAY = 24 * 60 * 60_000;

async function withProperty(lead: Lead, code: string): Promise<void> {
  // The conversation's earlier turns: the card was shown and pointed at.
  await query(
    `insert into messages (conversation_id, role, content, metadata, created_at)
     select $1, 'agent', 'Separei este imóvel para você.',
            jsonb_build_object('propertyIds', jsonb_build_array(p.id), 'interestedProperty', jsonb_build_object('id', p.id, 'code', p.code)),
            now() - interval '1 second'
       from properties p where p.code = $2`,
    [lead.conversationId, code],
  );
}

async function replay(name: string, lead: Lead, lines: string[]): Promise<void> {
  const out = [`\n=== ${name} (${process.env.MODEL_ID ?? "?"})`];
  for (const text of lines) {
    const turn = await lead.say(text);
    const calls = ((await lead.lastMetadata()).toolCalls ?? []) as { name: string; arguments: Record<string, unknown> }[];
    const facts = Object.entries(calls[0]?.arguments ?? {})
      .filter(([key, value]) => value !== false && value !== null && !["optOut", "attemptedAnswer"].includes(key))
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ");
    const actions = calls.slice(1).map((call) => call.name).join(",");
    out.push(`  L: ${text}`, `  A: ${turn.reply}`, `     [${facts}]${actions ? ` → ${actions}` : ""}`);
  }
  console.log(out.join("\n"));
}

test("replay 29/09", async (t) => {
  const leads: Lead[] = [];
  const lead = async () => {
    const created = await qualifiedLead({ brokerName: "Ana Ribeiro" });
    leads.push(created);
    return created;
  };
  t.after(async () => {
    for (const created of leads) await created.cleanup();
    await closePool();
  });

  // 1 · A call that already happened; the lead cancels it, then books and cancels a new one.
  const one = await lead();
  await bookDirect(one, { at: new Date(Date.now() - DAY), type: "call" });
  await replay("1 · cancel a meeting that already passed", one, [
    "não vou mais poder na terça",
    "ah verdade, essa já foi haha",
    "podemos marcar uma nova?",
    "quinta",
    "10h",
    "oi! não vou mais poder na quinta",
    "sim",
  ]);

  // 2 · A visit to MOE-0001 that already passed; the lead asks for a new one.
  const two = await lead();
  await withProperty(two, "MOE-0001");
  await bookDirect(two, { at: new Date(Date.now() - DAY), propertyCode: "MOE-0001" });
  await replay("2 · a new visit after the last one passed", two, [
    "oi! podemos marcar uma nova vista pra quinta?",
    "podemos marcar uma nova?",
    "3",
    "dá pra passar pra próxima segunda às 10 da manhã?",
  ]);

  // 3 · A visit booked; the lead wants a phone call too.
  const three = await lead();
  await withProperty(three, "MOE-0001");
  await bookDirect(three, { at: nextLocal("mon", 10), propertyCode: "MOE-0001" });
  await replay("3 · a phone call alongside a booked visit", three, [
    "queria também uma conversa por telefone.. essa pode ser amanhã de tarde mesmo",
    "nada na quarta?",
    "não quero remarcar a visita.. quero só uma conversa por telefone amanhã (além da visita)",
    "as 16h30",
    "obrigado!",
  ]);

  // 4 · A visit and a call booked; the lead moves the call.
  const four = await lead();
  await withProperty(four, "MOE-0001");
  await bookDirect(four, { at: nextLocal("mon", 10), propertyCode: "MOE-0001" });
  await bookDirect(four, { at: nextLocal("wed", 16, 30), type: "call" });
  await replay("4 · move one of two meetings", four, [
    "oi! queria remarcar",
    "a conversa.. tem como ser na sexta de manhã?",
    "2",
    "agradecido! 😊",
    "não, obrigado",
  ]);
});
