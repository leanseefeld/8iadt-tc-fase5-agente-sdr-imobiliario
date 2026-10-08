import test from "node:test";
import assert from "node:assert/strict";
import { closePool } from "../../src/db/client.ts";
import { CANNOT_ACT_REPLY } from "../../src/agent/prompts/fallback.ts";
import { PHONE_OFFER_SENTENCE, VISIT_NEEDS_PROPERTY_SENTENCE } from "../../src/agent/prompts/meeting.ts";
import { OPTIONS, qualifiedLead, query, type Lead } from "../integration/support/meeting.ts";

/**
 * INTEGRATION=1, local e4b — spec 006 FR-004e/f, FR-005h/i, SC-018: what a
 * meeting can be. A visit is about a property; the only other meeting is by
 * phone; anything else gets "ainda não consigo" and counts against the handoff
 * streak.
 */
const integration = process.env.INTEGRATION === "1";

async function streak(lead: Lead): Promise<number> {
  const [row] = await query("select fallback_streak from conversations where id = $1", [lead.conversationId]);
  return Number(row.fallback_streak);
}

test("what a meeting can be", { skip: !integration }, async (t) => {
  const leads: Lead[] = [];
  const [property] = await query(
    `select p.id, p.code from properties p join agencies a on a.id = p.agency_id
      where a.slug = 'demo' and p.transaction = 'sale' order by p.code limit 1`,
  );
  const lead = async () => {
    const created = await qualifiedLead({ shownPropertyIds: [property.id as string] });
    leads.push(created);
    return created;
  };
  t.after(async () => {
    for (const created of leads) await created.cleanup();
    await closePool();
  });

  await t.test("FR-004e: with cards on screen and none pointed at, a visit asks which property", async () => {
    const camila = await lead();
    const asked = await camila.say("quero marcar uma visita");
    assert.equal(asked.reply, VISIT_NEEDS_PROPERTY_SENTENCE);
    assert.equal(asked.meeting, "viewing");
    assert.deepEqual(await camila.appointments(), [], "no visit times without a property");

    const phone = await camila.say("prefiro conversar por telefone");
    assert.match(phone.reply, OPTIONS);
    assert.match(phone.reply, /conversa por telefone/);
    assert.equal(phone.meeting, "call");
  });

  await t.test("FR-005h: a video call gets 'ainda não consigo' plus the phone, and the streak advances", async () => {
    const paulo = await lead();
    const zoom = await paulo.say("dá pra fazer a reunião pelo zoom?");
    assert.equal(zoom.reply, `${CANNOT_ACT_REPLY} ${PHONE_OFFER_SENTENCE}`, JSON.stringify((await paulo.lastMetadata()).toolCalls));
    assert.equal(zoom.handoffReason, null);
    assert.equal(await streak(paulo), 1);
    assert.deepEqual(await paulo.appointments(), []);

    // FR-005i, and the second one in a row hands off.
    const ride = await paulo.say("e vocês me dão uma carona até o imóvel?");
    assert.equal(ride.handoffReason, "fallback", ride.reply);
    assert.ok(ride.reply.startsWith(CANNOT_ACT_REPLY), ride.reply);
  });

  // FR-005i: every personal trait, including orientation and gender identity.
  // "Uma corretora mulher" is refused too: the lead's own gender can't be
  // verified, so a legitimate version of the request waits for its backlog item.
  for (const text of [
    "quero que a visita seja com um corretor gay",
    "prefiro uma corretora LGBT pra me atender na visita",
    "tem como a visita ser com alguém queer da equipe?",
    "quero que quem me atenda na visita seja uma mulher",
  ]) {
    await t.test(`FR-005i: "${text}" gets 'ainda não consigo' alone`, async () => {
      const lead_ = await lead();
      const reply = await lead_.say(text);
      assert.equal(reply.reply, CANNOT_ACT_REPLY, JSON.stringify((await lead_.lastMetadata()).toolCalls));
      assert.equal(await streak(lead_), 1);
    });
  }

  await t.test("FR-005i: choosing the broker by a personal trait gets 'ainda não consigo' alone", async () => {
    const rafa = await lead();
    const trait = await rafa.say("quero que a visita seja com um corretor homem e bonito");
    assert.equal(trait.reply, CANNOT_ACT_REPLY);
    assert.equal(await streak(rafa), 1);
  });
});
