import test from "node:test";
import assert from "node:assert/strict";
import { closePool } from "../../src/db/client.ts";
import { useScriptedModel } from "../support/scripted-model.ts";
import { bookDirect, nextLocal, OPTIONS, qualifiedLead, query, type Lead } from "./support/meeting.ts";

/**
 * Spec 015's examples, with the model scripted: each case says what the
 * extraction read, so what is tested is the code's decision — offer, close,
 * handoff, refusal — never the sampler's phrasing.
 */
const integration = process.env.INTEGRATION === "1";

async function showProperty(lead: Lead, code: string): Promise<void> {
  await query(
    `insert into messages (conversation_id, role, content, metadata, created_at)
     select $1, 'agent', 'Separei este imóvel para você.',
            jsonb_build_object('propertyIds', jsonb_build_array(p.id)), now() - interval '1 second'
       from properties p where p.code = $2`,
    [lead.conversationId, code],
  );
}

test("spec 015, scripted", { skip: !integration }, async (t) => {
  const model = useScriptedModel();
  const leads: Lead[] = [];
  const lead = async () => {
    const created = await qualifiedLead({ brokerName: "Ana Ribeiro" });
    leads.push(created);
    return created;
  };
  t.after(async () => {
    model.restore();
    for (const created of leads) await created.cleanup();
    await closePool();
  });

  await t.test("1 · husband after booking: the offer, then a no closes", async () => {
    const ana = await lead();
    await bookDirect(ana, { at: nextLocal("mon", 10), propertyCode: "MOE-0001" });
    model.push(
      { facts: { messageAct: "inform", uncovered: "meu marido vai junto" }, reply: "Que bom! Quer que alguém da equipe verifique?" },
      { facts: { answer: "no" }, reply: "Beleza! Tô por aqui." },
    );
    await ana.say("meu marido vai junto");
    const offered = await ana.lastMetadata();
    assert.deepEqual(offered.humanOffer, { about: "meu marido vai junto" });
    assert.match(model.briefings.at(-1) ?? "", /a pessoa disse "meu marido vai junto"/);
    assert.equal(offered.closing, undefined, "an offer is not a close");

    const closed = await ana.say("não precisa");
    assert.match(closed.reply, /^Fica marcado: a visita ao MOE-0001 .*Beleza! Tô por aqui\.$/);
    const after = await ana.lastMetadata();
    assert.equal(after.closing, true);
    assert.equal(after.humanOffer, undefined, "no new offer");
  });

  await t.test("2 · dog: the offer, then a yes is the normal handoff", async () => {
    const bia = await lead();
    await bookDirect(bia, { at: nextLocal("tue", 14), propertyCode: "MOE-0001" });
    model.push(
      { facts: { messageAct: "question", uncovered: "o condomínio aceita cachorro?" } },
      { facts: { answer: "yes" } },
    );
    await bia.say("o condomínio aceita cachorro?");
    assert.deepEqual((await bia.lastMetadata()).humanOffer, { about: "o condomínio aceita cachorro?" });
    const handed = await bia.say("quero");
    assert.match(handed.reply, /já estou chamando um corretor/);
    const [row] = await query("select status from conversations where id = $1", [bia.conversationId]);
    assert.notEqual(row.status, "active", "the conversation went to a person");
  });

  await t.test("3 · discount is an offer, not a refusal", async () => {
    const leo = await lead();
    await bookDirect(leo, { at: nextLocal("wed", 10), propertyCode: "MOE-0001" });
    // The model forgets to ask: the code asks for it.
    model.push({ facts: { messageAct: "request", uncovered: "consegue um desconto?" }, reply: "Desconto eu não consigo negociar por aqui." });
    const reply = await leo.say("consegue um desconto?");
    assert.deepEqual((await leo.lastMetadata()).humanOffer, { about: "consegue um desconto?" });
    assert.match(reply.reply, /^Desconto eu não consigo negociar por aqui\. Quer que alguém da nossa equipe verifique isso pra você\?$/);
  });

  await t.test("4 · a ride stays a refusal", async () => {
    const rui = await lead();
    await bookDirect(rui, { at: nextLocal("wed", 14), propertyCode: "MOE-0001" });
    model.push({ facts: { outOfScopeRequest: true, messageAct: "request", uncovered: "carona até lá" } });
    await rui.say("vocês me dão carona até lá?");
    assert.equal((await rui.lastMetadata()).humanOffer, undefined);
  });

  await t.test("5 · a bare thanks closes even when the model calls it information; a second is short", async () => {
    const cid = await lead();
    await bookDirect(cid, { at: nextLocal("thu", 10), propertyCode: "MOE-0001" });
    model.push(
      { facts: { messageAct: "inform", uncovered: "valeu" }, reply: "Imagina!" },
      { facts: { messageAct: "thanks" }, reply: "De nada!" },
    );
    const first = await cid.say("valeu!");
    assert.match(first.reply, /^Fica marcado: a visita ao MOE-0001 .*Imagina!$/);
    assert.equal((await cid.lastMetadata()).humanOffer, undefined);
    const second = await cid.say("obrigado");
    assert.equal(second.reply, "De nada!", "courtesy only, no summary");
  });

  await t.test("6 · thanks with times on the table doesn't close", async () => {
    const dani = await lead();
    await showProperty(dani, "MOE-0001");
    model.push(
      { facts: { meetingKind: "visit", askedForTimes: true, propertyCode: "MOE-0001" } },
      { facts: { messageAct: "thanks" } },
    );
    const offered = await dani.say("quero visitar o MOE-0001");
    assert.match(offered.reply, OPTIONS);
    await dani.say("obrigado!");
    assert.equal((await dani.lastMetadata()).closing, undefined);
  });

  await t.test("a bare thanks after a refusal is not a second refusal (the model echoes the first)", async () => {
    const fabi = await lead();
    await bookDirect(fabi, { at: nextLocal("fri", 14), propertyCode: "MOE-0001" });
    model.push(
      { facts: { outOfScopeRequest: true, messageAct: "request" } },
      { facts: { outOfScopeRequest: true, messageAct: "thanks" }, reply: "Imagina!" },
    );
    await fabi.say("vocês me dão carona até lá?");
    const thanked = await fabi.say("valeu!");
    assert.match(thanked.reply, /Imagina!$/);
    assert.equal((await fabi.lastMetadata()).closing, true);
  });

  await t.test("a pick after an offer is a pick, not a yes to the offer", async () => {
    const gil = await lead();
    await showProperty(gil, "MOE-0001");
    model.push(
      { facts: { meetingKind: "visit", askedForTimes: true, propertyCode: "MOE-0001" } },
      { facts: { messageAct: "question", uncovered: "vocês trabalham com financiamento?" } },
      // The model reads the pick as a yes too; the pick wins.
      { facts: { pickedTime: true, answer: "yes" }, act: [{ tool: "bookMeeting", input: { optionIndex: 1 } }] },
    );
    await gil.say("quero visitar o MOE-0001");
    await gil.say("vocês trabalham com financiamento?");
    assert.deepEqual((await gil.lastMetadata()).humanOffer, { about: "vocês trabalham com financiamento?" });
    const booked = await gil.say("pode ser a primeira opção");
    assert.match(booked.reply, /^Pronto!/);
    assert.equal(booked.handoffReason, null);
  });

  await t.test("a question the task forbids is dropped, not sent", async () => {
    const hugo = await lead();
    await bookDirect(hugo, { at: nextLocal("thu", 14), propertyCode: "MOE-0001" });
    model.push({ facts: { messageAct: "thanks" }, reply: "Imagina! Quer marcar mais alguma visita?" });
    const closed = await hugo.say("obrigado!");
    assert.doesNotMatch(closed.reply, /\?/);
    assert.match(closed.reply, /Imagina!$/);
  });

  await t.test("'não vou mais poder' about a meeting that already passed: nothing to change, even unread", async () => {
    const ivo = await lead();
    await bookDirect(ivo, { at: new Date(Date.now() - 24 * 60 * 60_000), type: "call" });
    model.push({ facts: { messageAct: "inform", declinedOffer: true } });
    const reply = await ivo.say("não vou mais poder na terça");
    assert.match(reply.reply, /^Não tenho nenhuma visita ou conversa marcada/);
  });

  await t.test("7 · thanks with something left over is the offer, not the close", async () => {
    const eva = await lead();
    await bookDirect(eva, { at: nextLocal("fri", 10), propertyCode: "MOE-0001" });
    model.push({ facts: { messageAct: "thanks", uncovered: "meu marido vai junto" } });
    await eva.say("obrigado, e meu marido vai junto");
    const metadata = await eva.lastMetadata();
    assert.deepEqual(metadata.humanOffer, { about: "meu marido vai junto" });
    assert.equal(metadata.closing, undefined);
  });
});
