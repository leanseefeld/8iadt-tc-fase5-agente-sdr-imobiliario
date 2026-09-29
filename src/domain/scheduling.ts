/**
 * Meeting times and follow-up windows, as pure functions (spec 006).
 *
 * Every rule arrives as an argument — availability, notice, preferred hours,
 * timezone, and the instant itself. No config read, no clock read, no I/O. That
 * is what lets 200 generated calendars prove SC-002 with no database, and what
 * lets one function decide both "what to offer" and "may this be booked", so
 * the two can never disagree (FR-002, plan step 3a).
 *
 * Imports nothing (constitution III).
 */

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type WeekdayAvailability = { enabled: boolean; start: string; end: string };
export type Availability = Partial<Record<Weekday, WeekdayAvailability>>;
export type Interval = { start: Date; end: Date };
export type MeetingType = "viewing" | "call";
export type Option = { scheduledAt: Date; type: MeetingType };
export type Period = "morning" | "afternoon";
export type Preference = { weekday?: Weekday; period?: Period };

export type SlotRules = {
  /** The broker's own `users.availability`. A weekday absent or disabled offers nothing. */
  availability: Availability;
  minNoticeMinutes: number;
  /** HH:MM, in preference order. */
  preferredTimes: string[];
  /** IANA zone the availability and the preferred hours are read in. */
  timezone: string;
  /** What every option offered is. Decided by the caller (FR-003a), carried through. */
  type: MeetingType;
};

export type WindowRules = { windowStart: string; windowEnd: string; timezone: string };

/** How long a meeting holds the broker. Busy intervals and collisions both use it. */
export const MEETING_MINUTES = 60;
/** How far ahead options are searched: this many Monday–Friday days (no holiday calendar). */
export const HORIZON_BUSINESS_DAYS = 10;
/** FR-001. */
export const MAX_OPTIONS = 3;
/** Where "morning" ends, in local time. */
const NOON_MINUTES = 12 * 60;

const WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// Local-time arithmetic, with nothing but Intl
// ---------------------------------------------------------------------------

type LocalParts = { year: number; month: number; day: number; minutes: number; weekday: Weekday };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock parts of `instant` in `timeZone`. */
export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: parts.weekday.toLowerCase().slice(0, 3) as Weekday,
  };
}

/**
 * The instant at which `timeZone` reads year-month-day hh:mm. Two corrections
 * converge even across an offset change; São Paulo has none since 2019, but a
 * second agency need not be in São Paulo.
 */
export function zonedInstant(
  year: number,
  month: number,
  day: number,
  minutes: number,
  timeZone: string,
): Date {
  const target = Date.UTC(year, month - 1, day, 0, minutes);
  let guess = target;
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = localParts(new Date(guess), timeZone);
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, 0, seen.minutes);
    guess += target - seenAsUtc;
  }
  return new Date(guess);
}

function toMinutes(hhmm: string): number {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return hours * 60 + minutes;
}

/** The calendar day after `parts`, as year/month/day. */
function nextDay(parts: { year: number; month: number; day: number }): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function weekdayOf(parts: { year: number; month: number; day: number }): Weekday {
  return WEEKDAYS[new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()];
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

function overlaps(start: Date, busy: Interval[]): boolean {
  const end = start.getTime() + MEETING_MINUTES * MINUTE;
  return busy.some((interval) => start.getTime() < interval.end.getTime() && end > interval.start.getTime());
}

export type SlotVerdict = { ok: true } | { ok: false; reason: "too_soon" | "unavailable" | "collision" };

/**
 * May a meeting start at `at`? **The one rule** behind both the options offered
 * and every booking (FR-002, FR-005), so an option can never be offered that
 * booking would then refuse. Order of the checks decides which reason the lead
 * hears when several apply: notice first, then the broker's week, then the
 * calendar.
 */
export function checkSlot(at: Date, busy: Interval[], now: Date, rules: SlotRules): SlotVerdict {
  if (at.getTime() < now.getTime() + rules.minNoticeMinutes * MINUTE) return { ok: false, reason: "too_soon" };

  const local = localParts(at, rules.timezone);
  const day = rules.availability[local.weekday];
  if (day === undefined || !day.enabled) return { ok: false, reason: "unavailable" };
  // The whole meeting must fit inside the broker's hours, not only its start.
  if (local.minutes < toMinutes(day.start) || local.minutes + MEETING_MINUTES > toMinutes(day.end)) {
    return { ok: false, reason: "unavailable" };
  }

  if (overlaps(at, busy)) return { ok: false, reason: "collision" };
  return { ok: true };
}

/** Does `at` satisfy the lead's constraint? No constraint lets everything through. */
export function matchesPreference(at: Date, preference: Preference, timeZone: string): boolean {
  const local = localParts(at, timeZone);
  if (preference.weekday !== undefined && local.weekday !== preference.weekday) return false;
  if (preference.period === "morning" && local.minutes >= NOON_MINUTES) return false;
  if (preference.period === "afternoon" && local.minutes < NOON_MINUTES) return false;
  return true;
}

/** Options narrowed to a preference. It only ever removes, never adds (FR-005b). */
export function filterByPreference(options: Option[], preference: Preference, timeZone: string): Option[] {
  return options.filter((option) => matchesPreference(option.scheduledAt, preference, timeZone));
}

/**
 * Up to three options, earliest day first and, within a day, in the order of
 * `preferredTimes` (FR-001, FR-002). Searches `HORIZON_BUSINESS_DAYS` Monday–
 * Friday days forward; a weekend day the broker has enabled inside that span is
 * a candidate too. Never throws; `[]` means nothing fits.
 *
 * The preference is applied **before** the cap of three, not after: filtering
 * three Monday/Tuesday options for "quinta" would find nothing even when
 * Thursday is free.
 */
export function proposeSlots(
  busy: Interval[],
  now: Date,
  rules: SlotRules,
  preference: Preference = {},
): Option[] {
  const options: Option[] = [];
  let day: { year: number; month: number; day: number } = localParts(now, rules.timezone);
  let businessDaysSeen = 0;

  while (businessDaysSeen < HORIZON_BUSINESS_DAYS) {
    const weekday = weekdayOf(day);
    if (weekday !== "sat" && weekday !== "sun") businessDaysSeen += 1;

    for (const hhmm of rules.preferredTimes) {
      const at = zonedInstant(day.year, day.month, day.day, toMinutes(hhmm), rules.timezone);
      if (!checkSlot(at, busy, now, rules).ok) continue;
      if (!matchesPreference(at, preference, rules.timezone)) continue;
      options.push({ scheduledAt: at, type: rules.type });
      if (options.length === MAX_OPTIONS) return options;
    }
    day = nextDay(day);
  }
  return options;
}

// ---------------------------------------------------------------------------
// Broker rotation
// ---------------------------------------------------------------------------

/**
 * FR-003: the broker with the fewest assignments, ties to whoever comes first
 * in `brokerIds`. Even and repeatable, never random. The caller filters by
 * specialization and falls back to every broker; an empty list is its edge
 * (FR-001's "no brokers") to check first, so this throws.
 */
export function nextBrokerInRotation(brokerIds: string[], assignmentCounts: Record<string, number>): string {
  if (brokerIds.length === 0) throw new Error("nextBrokerInRotation needs at least one broker");
  let chosen = brokerIds[0];
  for (const id of brokerIds) {
    if ((assignmentCounts[id] ?? 0) < (assignmentCounts[chosen] ?? 0)) chosen = id;
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Follow-up window
// ---------------------------------------------------------------------------

/** Inside the daily window, in its own timezone? End is exclusive. */
export function isWithinWindow(instant: Date, rules: WindowRules): boolean {
  const { minutes } = localParts(instant, rules.timezone);
  return minutes >= toMinutes(rules.windowStart) && minutes < toMinutes(rules.windowEnd);
}

/**
 * The first instant at or after `instant` inside the window (FR-013): the
 * instant itself when already inside, today's opening when before it, and
 * tomorrow's opening when after it. An attempt due at 03:00 moves, never skips.
 */
export function nextWindowOpening(instant: Date, rules: WindowRules): Date {
  if (isWithinWindow(instant, rules)) return instant;
  const local = localParts(instant, rules.timezone);
  const start = toMinutes(rules.windowStart);
  const day = local.minutes < start ? local : nextDay(local);
  return zonedInstant(day.year, day.month, day.day, start, rules.timezone);
}
