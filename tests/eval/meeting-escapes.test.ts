import test from "node:test";
import assert from "node:assert/strict";
import { closePool } from "../../src/db/client.ts";
import { DECLINE_ACKNOWLEDGEMENT } from "../../src/agent/prompts/meeting.ts";
import { localParts } from "../../src/domain/scheduling.ts";
import { OPTIONS, qualifiedLead, type Lead } from "../integration/support/meeting.ts";

/**
 * INTEGRATION=1, local e4b — spec 006 T022a, quickstart §1a, SC-013: the three
 * ways out of an offer. Declining, asking for other times, and talking about
 * something else — after which a pick still books.
 */
const integration = process.env.INTEGRATION === "1";
const TZ = "America/Sao_Paulo";

test("the ways out of an offer", { skip: !integration }, async (t) => {
  const leads: Lead[] = [];
  const lead = async () => {
    const created = await qualifiedLead();
    leads.push(created);
    return created;
  };
  t.after(async () => {
    for (const created of leads) await created.cleanup();
    await closePool();
  });

  await t.test("a decline is acknowledged once, and three unrelated messages bring no new offer", async () => {
    const rafa = await lead();
    await rafa.say("ok");
    const declined = await rafa.say("agora não, obrigado");
    assert.ok(declined.reply.startsWith(DECLINE_ACKNOWLEDGEMENT), declined.reply);
    assert.doesNotMatch(declined.reply, /Tenho estes horários/);
    assert.deepEqual((await rafa.appointments()).map((row) => row.status), ["cancelled"]);
    for (const text of ["legal", "vocês trabalham com financiamento?", "beleza"]) {
      const reply = await rafa.say(text);
      assert.doesNotMatch(reply.reply, /Tenho estes horários/, `${text} → ${reply.reply}`);
      assert.equal(reply.meeting, null);
    }
  });

  await t.test("'tem outro horário? só de manhã' replaces the proposal with morning-only options", async () => {
    const paulo = await lead();
    await paulo.say("ok");
    const morning = await paulo.say("tem outro horário? só de manhã");
    assert.match(morning.reply, OPTIONS);
    const offered = (await paulo.lastMetadata()).meetingOptions as string[];
    assert.ok(offered.length > 0);
    assert.ok(offered.every((at) => localParts(new Date(at), TZ).minutes < 12 * 60), offered.join(", "));
    assert.deepEqual((await paulo.appointments()).map((row) => row.status), ["cancelled", "proposed"]);
  });

  await t.test("after a change of subject the options are not repeated, and a later pick still books", async () => {
    const camila = await lead();
    await camila.say("ok");
    const aside = await camila.say("vocês trabalham com financiamento?");
    assert.doesNotMatch(aside.reply, /Tenho estes horários/, JSON.stringify((await camila.lastMetadata()).toolCalls));
    assert.deepEqual((await camila.appointments()).map((row) => row.status), ["proposed"]);
    const booked = await camila.say("pode ser a primeira opção");
    assert.match(booked.reply, /^Pronto!/, JSON.stringify((await camila.lastMetadata()).toolCalls));
    assert.deepEqual((await camila.appointments()).map((row) => row.status), ["confirmed"]);
  });

  await t.test("T021 a revision after an offer takes 007's path, and the proposal stays open", async () => {
    const rafa = await lead();
    await rafa.say("ok");
    const revised = await rafa.say("e em moema, tem algo?");
    assert.doesNotMatch(revised.reply, /Tenho estes horários/);
    const metadata = await rafa.lastMetadata();
    assert.ok(
      (metadata.toolCalls as { name: string }[]).some((call) => call.name === "searchProperties"),
      "the revised criteria were searched",
    );
    assert.deepEqual((await rafa.appointments()).map((row) => row.status), ["proposed"]);
  });
});
