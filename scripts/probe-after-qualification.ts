import { randomUUID } from "node:crypto";
import { closePool, getPool } from "../src/db/client.ts";
import { collectingSink, runTurn } from "../src/agent/orchestrator.ts";
import { recordLeadMessage } from "../src/services/conversation.ts";

const MSGS = [
  "Estou procurando apartamento na zona sul", "Até uns 700 mil",
  "Pelo menos 2, um deles como escritório", "Tenho preferência por Moema ou Vila Mariana",
  "Preciso me mudar em até 2 meses", "Meu nome é Camila Duarte", "Meu telefone é (11) 98765-4321",
  "Gostei do segundo, ele tem varanda?", "E na zona norte, tem algo?", "Pode ser sábado de manhã?",
];
const sessionId = `probe-${randomUUID()}`;
let conversationId = "", leadId = "";
for (const text of MSGS) {
  const inbound = await recordLeadMessage({ agencySlug: "demo", externalId: sessionId, clientMessageId: randomUUID(), text, consent: true });
  if (!("conversationId" in inbound)) { console.log("refused", text, inbound); break; }
  conversationId = inbound.conversationId; leadId = inbound.leadId;
  const sink = collectingSink();
  const r: any = await runTurn({ conversationId, sink });
  const [c] = (await getPool().query("select status, fallback_streak from conversations where id=$1", [conversationId])).rows;
  const [l] = (await getPool().query("select score, status from leads where id=$1", [leadId])).rows;
  const [m] = (await getPool().query("select content, metadata from messages where conversation_id=$1 and role='agent' order by created_at desc limit 1", [conversationId])).rows;
  console.log(JSON.stringify({ lead: text, outcome: r.outcome, conv: c.status, streak: c.fallback_streak, score: l.score, stage: l.status, cards: (m.metadata.propertyIds ?? []).length, tools: (m.metadata.toolCalls ?? []).map((t: any) => t.name), reply: m.content }));
  if (c.status !== "active") break;
}
await getPool().query("delete from events where lead_id=$1", [leadId]);
await getPool().query("delete from messages where conversation_id=$1", [conversationId]);
await getPool().query("delete from conversations where id=$1", [conversationId]);
await getPool().query("delete from leads where id=$1", [leadId]);
await closePool();
process.exit(0);
