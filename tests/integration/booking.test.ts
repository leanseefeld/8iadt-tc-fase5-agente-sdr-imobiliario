import test from "node:test";
import assert from "node:assert/strict";
import { closePool } from "../../src/db/client.ts";
import { ATTENDEE_UNKNOWN_SENTENCE, BOOKING_REFUSED, NO_OPTIONS_FOR_CONSTRAINT_SENTENCE } from "../../src/agent/prompts/meeting.ts";
import { OPTIONS, qualifiedLead, query, toolNames, type Lead } from "./support/meeting.ts";

/**
 * INTEGRATION=1, local e4b — spec 006 T019, T020, T022c. The bring-up of the
 * one new tool in the Gemma playbook's order: the obvious case first, then the
 * refusal path. Options and confirmations are code-written, so the assertions
 * on wording are exact; what the model contributes is whether it called
 * `bookMeeting`, and with what.
 */
const integration = process.env.INTEGRATION === "1";

test("booking a meeting", { skip: !integration }, async (t) => {
  const leads: Lead[] = [];
  const lead = async (options?: Parameters<typeof qualifiedLead>[0]) => {
    const created = await qualifiedLead(options);
    leads.push(created);
    return created;
  };
  t.after(async () => {
    for (const created of leads) await created.cleanup();
    await closePool();
  });

  await t.test("T019 the obvious case: options, then 'a segunda opção' books it", async () => {
    const camila = await lead();
    const offer = await camila.say("ok");
    assert.match(offer.reply, OPTIONS);
    assert.notEqual(offer.meeting, null);
    const offered = (await camila.lastMetadata()).meetingOptions as string[];
    assert.ok(offered.length >= 2, "at least two options to pick the second of");

    const booked = await camila.say("pode ser a segunda opção");
    assert.match(booked.reply, /^Pronto! .* está confirmada para .*, com alguém da nossa equipe\.$/);
    assert.deepEqual(toolNames(await camila.lastMetadata()).filter((name) => name === "bookMeeting"), ["bookMeeting"]);
    const rows = await camila.appointments();
    assert.deepEqual(rows.map((row) => row.status), ["confirmed"]);
    assert.equal(new Date(rows[0].scheduled_at).toISOString(), offered[1]);
    const [stage] = await query("select status from leads where id = $1", [camila.leadId]);
    assert.equal(stage.status, "scheduled");
    assert.equal(booked.stage, "scheduled");

    // FR-005e: who attends is neither named nor guessed, and asking is not a handoff.
    const who = await camila.say("quem vai me atender?");
    assert.equal(who.reply, ATTENDEE_UNKNOWN_SENTENCE, JSON.stringify((await camila.lastMetadata()).toolCalls));
    assert.equal(who.handoffReason, null);
  });

  await t.test("T020 a time outside the broker's week: a readable refusal, fresh options, nothing confirmed", async () => {
    const paulo = await lead();
    await paulo.say("ok");
    const refused = await paulo.say("pode ser domingo às 7 da manhã?");
    // Three valid readings, all ending in no booking and times on screen: the
    // model books the named time and hears the refusal; it calls nothing and the
    // options come back; or the extraction reads "domingo" as a day constraint,
    // which nothing satisfies, and the earlier options stand (FR-005b).
    const reasons = Object.values(BOOKING_REFUSED).map((reason) => reason.replace(/[.?]/g, "\\$&"));
    assert.match(
      refused.reply,
      new RegExp(`^((${reasons.join("|")}) )?Tenho estes horários|^${NO_OPTIONS_FOR_CONSTRAINT_SENTENCE} Os horários que te passei continuam valendo`),
    );
    assert.ok(!(await paulo.appointments()).some((row) => row.status === "confirmed"));
  });

  await t.test("T020 two leads offered the same hour: the second to pick hears it was taken", async () => {
    const first = await lead({ brokerName: "Ana Ribeiro" });
    const second = await lead({ brokerName: "Ana Ribeiro" });
    await first.say("ok");
    await second.say("ok");
    const a = await first.say("pode ser a primeira opção");
    assert.match(a.reply, /^Pronto!/);
    const b = await second.say("pode ser a primeira opção");
    assert.match(b.reply, new RegExp(`^${BOOKING_REFUSED.collision} Tenho estes horários`));
    assert.ok(!(await second.appointments()).some((row) => row.status === "confirmed"));
  });

  await t.test("T022c 'Interessado em <code>' with a complete script: options for that property, then a booking naming it", async () => {
    const [property] = await query(
      `select p.id, p.code from properties p join agencies a on a.id = p.agency_id
        where a.slug = 'demo' and p.transaction = 'sale' order by p.code limit 1`,
    );
    const rafa = await lead({ shownPropertyIds: [property.id as string] });
    const offer = await rafa.say(`Interessado em ${property.code}`);
    assert.match(offer.reply, new RegExp(`^Tenho estes horários para uma visita ao ${property.code} com alguém da nossa equipe`));
    assert.equal(offer.meeting, "viewing");
    const booked = await rafa.say("a primeira opção");
    assert.match(booked.reply, new RegExp(`^Pronto! Sua visita ao ${property.code} está confirmada`));
    const [row] = await rafa.appointments().then((rows) => rows.filter((r) => r.status === "confirmed"));
    assert.equal(row.property_id, property.id);
    assert.equal(row.type, "viewing");
  });
});
