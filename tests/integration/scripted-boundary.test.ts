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
    // The model restates what is booked; the code hands it the facts.
    assert.equal(closed.reply, "Beleza! Tô por aqui.");
    assert.match(model.briefings.at(-1) ?? "", /lembre o que fica marcado.*a visita ao MOE-0001: seg/s);
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
    assert.equal(first.reply, "Imagina!");
    assert.match(model.briefings.at(-1) ?? "", /lembre o que fica marcado/);
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

  await t.test("'a visita continua de pé?' is answered from what is booked (decided 30/09)", async () => {
    const jana = await lead();
    await bookDirect(jana, { at: nextLocal("mon", 10), propertyCode: "MOE-0001" });
    model.push({ facts: { askedAboutMeetings: true, messageAct: "question" }, reply: "Sim, continua marcada!" });
    const reply = await jana.say("a visita de segunda continua de pé?");
    assert.equal(reply.reply, "Sim, continua marcada!");
    const briefing = model.briefings.at(-1) ?? "";
    assert.match(briefing, /Compromissos marcados: a visita ao MOE-0001: seg/);
    assert.match(briefing, /perguntou sobre o que está marcado/);
    assert.equal((await jana.lastMetadata()).humanOffer, undefined, "not an offer: the agent knows");
  });

  await t.test("the same question with nothing booked: nothing to answer, an offer to book", async () => {
    const kai = await lead();
    model.push({ facts: { askedAboutMeetings: true, messageAct: "question" } });
    const reply = await kai.say("a visita continua de pé?");
    assert.match(reply.reply, /^Não tenho nenhuma visita ou conversa marcada/);
  });

  await t.test("who attends: what the agent can see, only brokers confirm, and a yes calls one (decided 30/09)", async () => {
    const lia = await lead();
    await bookDirect(lia, { at: nextLocal("tue", 10), propertyCode: "MOE-0001" });
    model.push({ facts: { askedWhoAttends: true, messageAct: "question" } }, { facts: { answer: "yes" } });
    const said = await lia.say("quem vai estar na visita?");
    assert.match(said.reply, /só os corretores conseguem confirmar/);
    assert.doesNotMatch(said.reply, /Ana|Ribeiro/);
    assert.deepEqual((await lia.lastMetadata()).humanOffer, { about: "quem vai atender" });
    const handed = await lia.say("sim");
    assert.match(handed.reply, /já estou chamando um corretor/);
  });

  await t.test("the conversation of 07/10: the dog after booking is an offer, not times, nor a refusal", async () => {
    const leleco = await lead();
    await bookDirect(leleco, { at: nextLocal("tue", 10), propertyCode: "MOE-0001" });
    model.push(
      // The model echoed the card's code: the code was not in the words.
      { facts: { propertyCode: "MOE-0001", messageAct: "inform", uncovered: "vou levar meu cachorro" } },
      { facts: { messageAct: "question" }, reply: "Sim, está marcada!" },
      // The model marked a refusal: no refusal word in the message.
      { facts: { outOfScopeRequest: true, messageAct: "question", uncovered: "posso levar meu cachorro?" } },
    );
    const dog = await leleco.say("vou levar meu cachorro");
    assert.doesNotMatch(dog.reply, OPTIONS, "no times again");
    assert.deepEqual((await leleco.lastMetadata()).humanOffer, { about: "vou levar meu cachorro" });
    const booked = await leleco.say("já marcamos, não?");
    assert.equal(booked.reply, "Sim, está marcada!", "answered from the state");
    const asked = await leleco.say("posso levar meu cachorro?");
    assert.doesNotMatch(asked.reply, /Ainda não consigo/);
    assert.equal(asked.handoffReason, null);
    assert.deepEqual((await leleco.lastMetadata()).humanOffer, { about: "posso levar meu cachorro?" });
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
