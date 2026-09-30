import { localParts, type Weekday } from "../domain/scheduling.ts";
import type { MeetingRef } from "./prompts/meeting.ts";

/**
 * Spec 009 — which booked meeting does the lead mean? Pure, so the rule is
 * tested without a model or a database.
 *
 * Narrow by what the message names: a property code, a weekday, a kind (visit
 * or phone). For a **reschedule**, a weekday names where the meeting should
 * go, not which one it is ("passa pra segunda"), so it doesn't narrow. One left
 * is the answer; none or several means asking.
 */
export function chooseMeeting(
  meetings: MeetingRef[],
  hints: { code: string | null; weekday: Weekday | null; kind: "visit" | "call" | null },
  change: "cancel" | "reschedule",
  timeZone: string,
): { meeting: MeetingRef } | { ask: MeetingRef[] } | { none: true } {
  if (meetings.length === 0) return { none: true };
  if (meetings.length === 1) return { meeting: meetings[0] };

  let candidates = meetings;
  const narrow = (keep: (meeting: MeetingRef) => boolean) => {
    const kept = candidates.filter(keep);
    if (kept.length > 0) candidates = kept;
  };
  if (hints.code !== null) narrow((meeting) => meeting.propertyCode?.toUpperCase() === hints.code?.toUpperCase());
  if (hints.kind !== null) narrow((meeting) => (hints.kind === "call") === (meeting.type === "call"));
  if (hints.weekday !== null && change === "cancel") {
    narrow((meeting) => localParts(meeting.scheduledAt, timeZone).weekday === hints.weekday);
  }
  return candidates.length === 1 ? { meeting: candidates[0] } : { ask: candidates };
}

const WEEKDAY_WORDS: Record<Weekday, string[]> = {
  mon: ["segunda"],
  tue: ["terca", "terça"],
  wed: ["quarta"],
  thu: ["quinta"],
  fri: ["sexta"],
  sat: ["sabado", "sábado"],
  sun: ["domingo"],
};

/**
 * The lead's answer to "qual delas?", matched against the meetings the agent
 * itself just listed — a closed set, so this is reading a choice, not guessing
 * intent: "a de terça", "a do MOE-0008", "a por telefone", "a do dia 08".
 * Returns the one meeting the answer singles out, or `null`.
 */
export function matchAnswer(pool: MeetingRef[], text: string, timeZone: string): MeetingRef | null {
  const said = text.toLowerCase();
  const hits = pool.filter((meeting) => {
    const local = localParts(meeting.scheduledAt, timeZone);
    if (meeting.propertyCode !== null && said.includes(meeting.propertyCode.toLowerCase())) return true;
    if (WEEKDAY_WORDS[local.weekday].some((word) => new RegExp(`\\b${word}`).test(said))) return true;
    if (meeting.type === "call" && /telefone|liga[çc][ãa]o|conversa/.test(said)) return true;
    // "dia 8", "dia 08", "08/01"
    const month = String(local.month).padStart(2, "0");
    return new RegExp(`\\bdia\\s+0?${local.day}\\b|\\b0?${local.day}/${month}\\b`).test(said);
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * The day and period a message names, read by code from a closed vocabulary —
 * the weekday names, "manhã"/"tarde", and "hoje"/"amanhã"/"depois de amanhã",
 * which are relative to `now`. The 4-bit extraction missed "nada na quarta?"
 * entirely and read "amanhã" as a random weekday; a calendar word is not a
 * judgement call. The model's own reading still counts where this finds nothing.
 */
export function parseWhen(text: string, now: Date, timeZone: string): { weekday?: Weekday; period?: "morning" | "afternoon" } {
  // "a segunda opção" is option two, not Monday.
  const said = text.toLowerCase().replace(/segunda\s+op[çc][ãa]o/gu, "");
  // A whole word, accents included: `\b` doesn't see "ã" as a letter.
  const word = (pattern: string) => new RegExp(`(?<!\\p{L})(?:${pattern})(?!\\p{L})`, "u").test(said);
  const DAY = 24 * 60 * 60_000;
  const found: { weekday?: Weekday; period?: "morning" | "afternoon" } = {};
  if (word("depois de amanh[ãa]")) found.weekday = localParts(new Date(now.getTime() + 2 * DAY), timeZone).weekday;
  else if (word("amanh[ãa]")) found.weekday = localParts(new Date(now.getTime() + DAY), timeZone).weekday;
  else if (word("hoje")) found.weekday = localParts(now, timeZone).weekday;
  else {
    const hits = (Object.keys(WEEKDAY_WORDS) as Weekday[]).filter((day) => WEEKDAY_WORDS[day].some((name) => word(`${name}(?:-feira)?`)));
    if (hits.length === 1) found.weekday = hits[0];
  }
  // "amanhã de manhã": "amanhã" is the day; "de manhã" is the period.
  const morning = word("(?:de|pela) manh[ãa]") || word("manh[ãa]zinha");
  const afternoon = word("(?:de|à|a|pela) tarde") || word("fim de tarde");
  if (morning !== afternoon) found.period = morning ? "morning" : "afternoon";
  return found;
}
