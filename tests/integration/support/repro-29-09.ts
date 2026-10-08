import test from "node:test";
import { closePool } from "../../../src/db/client.ts";
import { closeNotifier } from "../../../src/core/notifier.ts";
import { assumeConversation, returnToAgent, sendBrokerReply } from "../../../src/services/handoff.ts";
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

/** `REPLAY_ONLY=6,7` replays just those conversations. */
const only = (process.env.REPLAY_ONLY ?? "").split(",").filter((n) => n !== "");

async function replay(name: string, lead: Lead, lines: string[]): Promise<void> {
  if (only.length > 0 && !only.includes(name.split(" ")[0])) return;
  const out = [`\n=== ${name} (${process.env.MODEL_ID ?? "?"})`];
  for (const text of lines) {
    let turn;
    try {
      turn = await lead.say(text);
    } catch (error) {
      // A handoff pauses the conversation; what follows goes to a person.
      out.push(`  L: ${text}`, `  (sem turno: ${(error as Error).message})`);
      break;
    }
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
    await closeNotifier();
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

  // 5 · Closing, the cases the phone tests didn't reach: a thank-you with times
  // still on the table is not a goodbye; after a close, the lead comes back.
  const five = await lead();
  await withProperty(five, "MOE-0001");
  await replay("5 · a thank-you with options open, a close, and a return", five, [
    "quero visitar o MOE-0001",
    "obrigado!",
    "a primeira",
    "valeu!",
    "oi, tudo bem? queria ver outros imóveis também",
  ]);

  // 6–9 · Spec 015: what Sofia can't resolve, each with a visit booked.
  const booked = async () => {
    const created = await lead();
    await withProperty(created, "MOE-0001");
    await bookDirect(created, { at: nextLocal("mon", 10), propertyCode: "MOE-0001" });
    return created;
  };
  await replay("6 · 015: husband, then no", await booked(), ["meu marido vai junto", "não precisa"]);
  await replay("7 · 015: dog, then yes", await booked(), ["o condomínio aceita cachorro?", "quero"]);
  await replay("8 · 015: discount, ride, thanks", await booked(), [
    "consegue um desconto?",
    "vocês me dão carona até lá?",
    "valeu!",
  ]);
  await replay("9 · 015: thanks with something left over", await booked(), ["obrigado, e meu marido vai junto"]);

  // 12 · The developer's phone test of 07/10, after booking.
  await replay("12 · 07/10: the dog after booking", await booked(), [
    "vou levar meu cachorro",
    "já marcamos, não?",
    "posso levar meu cachorro?",
  ]);

  // 10–11 · A person takes over and hands back: after the lead took the offer,
  // and by the broker's own initiative. Printed as the whole conversation.
  const [ana] = await query("select id, agency_id from users where email = 'ana@demo.com.br'");
  const scope = { agencyId: ana.agency_id as string, defaultOwnLeadsOnly: true };
  const brokerSteps = async (name: string, created: Lead, steps: Array<[string, string]>) => {
    if (only.length > 0 && !only.includes(name.split(" ")[0])) return;
    const since = new Date();
    for (const [who, text] of steps) {
      if (who === "lead") {
        try {
          await created.say(text);
        } catch {
          // Held by a person: the message was stored, and no turn ran.
        }
      } else if (who === "assume") await assumeConversation(scope, created.leadId, ana.id as string);
      else if (who === "return") await returnToAgent(scope, created.leadId, ana.id as string);
      else await sendBrokerReply(scope, created.leadId, ana.id as string, text);
    }
    const rows = await query(
      "select role, content from messages where conversation_id = $1 and created_at >= $2 order by created_at",
      [created.conversationId, since],
    );
    const tag: Record<string, string> = { lead: "L", agent: "A", broker: "Ana" };
    console.log([`\n=== ${name} (${process.env.MODEL_ID ?? "?"})`, ...rows.map((row) => `  ${tag[row.role as string] ?? row.role}: ${row.content}`)].join("\n"));
  };
  await brokerSteps("10 · 015: offer taken, Ana answers and hands back", await booked(), [
    ["lead", "o condomínio aceita cachorro?"],
    ["lead", "quero"],
    ["assume", ""],
    ["broker", "Oi Camila, aqui é a Ana! Aceita sim, animais de pequeno porte. Mais alguma dúvida?"],
    ["lead", "não, era só isso. obrigada!"],
    ["return", ""],
    ["lead", "ah, e a visita de segunda continua de pé né?"],
  ]);
  await brokerSteps("11 · 015: Ana steps in on her own, then hands back", await booked(), [
    ["lead", "quero saber mais sobre o bairro"],
    ["assume", ""],
    ["broker", "Oi Camila, aqui é a Ana, vou te acompanhar na visita de segunda. Quer que eu te mande a planta do apartamento?"],
    ["lead", "pode sim!"],
    ["broker", "Enviei no seu e-mail. Qualquer coisa, me chama!"],
    ["return", ""],
    ["lead", "recebi, obrigada! quem vai estar na visita mesmo?"],
  ]);
});
