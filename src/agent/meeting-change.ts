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
