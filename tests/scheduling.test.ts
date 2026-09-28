import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_OPTIONS,
  MEETING_MINUTES,
  checkSlot,
  filterByPreference,
  isWithinWindow,
  localParts,
  nextWindowOpening,
  proposeSlots,
  zonedInstant,
  type Availability,
  type Interval,
  type Preference,
  type SlotRules,
  type Weekday,
} from "../src/domain/scheduling.ts";

/**
 * SC-002: across 200 generated broker calendars, no option collides with a
 * confirmed appointment, falls on a day or hour the broker has not enabled, or
 * falls inside the minimum notice — and the options are exactly the first
 * three a brute-force search would find, in order.
 *
 * The oracle below is deliberately written a different way from the module:
 * São Paulo has had a fixed UTC−3 offset since 2019, so it converts with plain
 * arithmetic instead of Intl. A timezone bug in the module cannot hide behind
 * the same bug in its own test.
 */

const TZ = "America/Sao_Paulo";
const OFFSET_MS = -3 * 60 * 60_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WEEK: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Mulberry32: small, seeded, reproducible. A failure prints its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const toMin = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));

/** Oracle-side local time: UTC−3, no Intl. */
function oracleLocal(at: Date): { dayIndex: number; minutes: number; weekday: Weekday } {
  const shifted = at.getTime() + OFFSET_MS;
  const dayIndex = Math.floor(shifted / DAY);
  return {
    dayIndex,
    minutes: Math.round((shifted - dayIndex * DAY) / MINUTE),
    weekday: WEEK[new Date(dayIndex * DAY).getUTCDay()],
  };
}
const oracleInstant = (dayIndex: number, minutes: number) => new Date(dayIndex * DAY + minutes * MINUTE - OFFSET_MS);

function oracleValid(at: Date, busy: Interval[], now: Date, rules: SlotRules): boolean {
  if (at.getTime() < now.getTime() + rules.minNoticeMinutes * MINUTE) return false;
  const local = oracleLocal(at);
  const day = rules.availability[local.weekday];
  if (!day?.enabled) return false;
  if (local.minutes < toMin(day.start) || local.minutes + MEETING_MINUTES > toMin(day.end)) return false;
  const end = at.getTime() + MEETING_MINUTES * MINUTE;
  return !busy.some((b) => at.getTime() < b.end.getTime() && end > b.start.getTime());
}

function oracleMatches(at: Date, pref: Preference): boolean {
  const local = oracleLocal(at);
  if (pref.weekday && local.weekday !== pref.weekday) return false;
  if (pref.period === "morning" && local.minutes >= 12 * 60) return false;
  if (pref.period === "afternoon" && local.minutes < 12 * 60) return false;
  return true;
}

/** Brute force: walk the same horizon day by day, preferred times in order. */
function oracle(busy: Interval[], now: Date, rules: SlotRules, pref: Preference): Date[] {
  const found: Date[] = [];
  let dayIndex = oracleLocal(now).dayIndex;
  let business = 0;
  while (business < 10) {
    const weekday = WEEK[new Date(dayIndex * DAY).getUTCDay()];
    if (weekday !== "sat" && weekday !== "sun") business += 1;
    for (const time of rules.preferredTimes) {
      const at = oracleInstant(dayIndex, toMin(time));
      if (oracleValid(at, busy, now, rules) && oracleMatches(at, pref)) found.push(at);
    }
    dayIndex += 1;
  }
  return found.slice(0, MAX_OPTIONS);
}

type Case = { busy: Interval[]; now: Date; rules: SlotRules; pref: Preference };

function generate(seed: number): Case {
  const r = rng(seed);
  const pick = <T>(items: T[]) => items[Math.floor(r() * items.length)];

  const availability: Availability = {};
  for (const weekday of WEEK) {
    const start = 7 * 60 + Math.floor(r() * 9) * 30; // 07:00–11:00
    const end = 14 * 60 + Math.floor(r() * 13) * 30; // 14:00–20:00
    availability[weekday] = { enabled: r() < (weekday === "sat" || weekday === "sun" ? 0.2 : 0.8), start: hhmm(start), end: hhmm(end) };
  }

  const grid = Array.from({ length: 24 }, (_, i) => hhmm(8 * 60 + i * 30)); // 08:00–19:30
  const preferredTimes = [...new Set(Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(grid)))];

  // Any minute in 2026–2027, so every weekday and time of day turns up as "now".
  const now = new Date(Date.UTC(2026, 0, 1) + Math.floor(r() * 700 * DAY / MINUTE) * MINUTE);

  const busy: Interval[] = [];
  const nowDay = oracleLocal(now).dayIndex;
  for (let i = Math.floor(r() * 16); i > 0; i -= 1) {
    const start = oracleInstant(nowDay + Math.floor(r() * 15), 8 * 60 + Math.floor(r() * 24) * 30);
    busy.push({ start, end: new Date(start.getTime() + MEETING_MINUTES * MINUTE) });
  }

  const pref: Preference = {};
  if (r() < 0.3) pref.weekday = pick(["mon", "tue", "wed", "thu", "fri"] as Weekday[]);
  if (r() < 0.3) pref.period = pick(["morning", "afternoon"] as const);

  return {
    busy,
    now,
    pref,
    rules: {
      availability,
      preferredTimes,
      minNoticeMinutes: Math.floor(r() * 49) * 60, // 0–48 h
      timezone: TZ,
      type: r() < 0.5 ? "viewing" : "call",
    },
  };
}

test("SC-002: 200 generated calendars — every option is valid, and they are the first three that exist", () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const { busy, now, rules, pref } = generate(seed);
    const options = proposeSlots(busy, now, rules, pref);
    const context = `seed ${seed}`;

    assert.ok(options.length <= MAX_OPTIONS, context);
    for (const option of options) {
      assert.ok(oracleValid(option.scheduledAt, busy, now, rules), `${context}: ${option.scheduledAt.toISOString()} is not a valid slot`);
      assert.ok(oracleMatches(option.scheduledAt, pref), `${context}: ${option.scheduledAt.toISOString()} ignores the preference`);
      assert.equal(option.type, rules.type, context);
    }
    assert.deepEqual(
      options.map((option) => option.scheduledAt.toISOString()),
      oracle(busy, now, rules, pref).map((at) => at.toISOString()),
      `${context}: not the first three valid slots in order`,
    );
  }
});

test("the preference narrows before the cap: 'quinta' finds Thursday even when earlier days fill three slots", () => {
  const monday = new Date("2026-10-05T11:00:00Z"); // 08:00 in São Paulo, a Monday
  const rules: SlotRules = {
    availability: Object.fromEntries(WEEK.map((w) => [w, { enabled: w !== "sat" && w !== "sun", start: "09:00", end: "18:00" }])),
    preferredTimes: ["10:00", "14:00", "16:30"],
    minNoticeMinutes: 60,
    timezone: TZ,
    type: "viewing",
  };
  const plain = proposeSlots([], monday, rules);
  assert.ok(plain.every((option) => localParts(option.scheduledAt, TZ).weekday === "mon"));
  assert.equal(filterByPreference(plain, { weekday: "thu" }, TZ).length, 0, "filtering after the cap would find nothing");

  const thursdays = proposeSlots([], monday, rules, { weekday: "thu" });
  assert.equal(thursdays.length, 3);
  assert.ok(thursdays.every((option) => localParts(option.scheduledAt, TZ).weekday === "thu"));
});

test("checkSlot is the booking rule: it names why a time is refused", () => {
  const now = new Date("2026-10-05T11:00:00Z"); // Mon 08:00 local
  const rules: SlotRules = {
    availability: { mon: { enabled: true, start: "09:00", end: "18:00" } },
    preferredTimes: ["10:00"],
    minNoticeMinutes: 120,
    timezone: TZ,
    type: "call",
  };
  const at = (local: string) => new Date(`2026-10-05T${local}:00-03:00`);
  assert.deepEqual(checkSlot(at("09:30"), [], now, rules), { ok: false, reason: "too_soon" });
  assert.deepEqual(checkSlot(at("17:30"), [], now, rules), { ok: false, reason: "unavailable" }, "the meeting would run past 18:00");
  assert.deepEqual(checkSlot(new Date("2026-10-06T14:00:00Z"), [], now, rules), { ok: false, reason: "unavailable" }, "Tuesday is not enabled");
  const busy = [{ start: at("11:30"), end: at("12:30") }];
  assert.deepEqual(checkSlot(at("11:00"), busy, now, rules), { ok: false, reason: "collision" });
  assert.deepEqual(checkSlot(at("11:00"), [], now, rules), { ok: true }, "an hour outside the preferred list is still bookable");
});

test("zonedInstant survives a DST change, which São Paulo no longer has but another agency may", () => {
  // 2026-03-08 02:30 does not exist in New York; 10:00 on either side of the change does.
  const before = zonedInstant(2026, 3, 7, 10 * 60, "America/New_York");
  const after = zonedInstant(2026, 3, 9, 10 * 60, "America/New_York");
  assert.equal(before.toISOString(), "2026-03-07T15:00:00.000Z");
  assert.equal(after.toISOString(), "2026-03-09T14:00:00.000Z");
});

test("the follow-up window: inside stays, before opens today, after opens tomorrow", () => {
  const window = { windowStart: "09:00", windowEnd: "20:00", timezone: TZ };
  const inside = new Date("2026-10-05T15:00:00Z"); // 12:00 local
  assert.ok(isWithinWindow(inside, window));
  assert.equal(nextWindowOpening(inside, window).toISOString(), inside.toISOString());

  const early = new Date("2026-10-05T06:00:00Z"); // 03:00 local
  assert.equal(isWithinWindow(early, window), false);
  assert.equal(nextWindowOpening(early, window).toISOString(), "2026-10-05T12:00:00.000Z");

  const late = new Date("2026-10-05T23:30:00Z"); // 20:30 local
  assert.equal(nextWindowOpening(late, window).toISOString(), "2026-10-06T12:00:00.000Z");
});
