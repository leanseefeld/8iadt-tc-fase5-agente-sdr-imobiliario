import { localParts, type MeetingType, type Weekday } from "../../domain/scheduling.ts";

/**
 * The scheduling sentences, written by code and said verbatim (spec 006 FR-005d).
 *
 * They are dates, times and counts — exactly what a model must not invent and
 * what the `unbackedFigure` guard exists to stop — so no model phrases them.
 * None of them names a broker (FR-005e): the team calendar is internal, and who
 * attends can change at the last minute.
 */

const WEEKDAY: Record<Weekday, string> = {
  mon: "seg",
  tue: "ter",
  wed: "qua",
  thu: "qui",
  fri: "sex",
  sat: "sáb",
  sun: "dom",
};

const WHO = "alguém da nossa equipe";

/** "qui 02/10 às 10h", "sex 03/10 às 16h30" — in the agency's timezone. */
export function slotLabel(at: Date, timeZone: string): string {
  const local = localParts(at, timeZone);
  const hours = Math.floor(local.minutes / 60);
  const minutes = local.minutes % 60;
  const time = minutes === 0 ? `${hours}h` : `${hours}h${String(minutes).padStart(2, "0")}`;
  return `${WEEKDAY[local.weekday]} ${String(local.day).padStart(2, "0")}/${String(local.month).padStart(2, "0")} às ${time}`;
}

function what(type: MeetingType, propertyCode: string | null): string {
  if (type === "call") return "uma conversa por telefone";
  return propertyCode === null ? "uma visita" : `uma visita ao ${propertyCode}`;
}

/** FR-001, FR-004a: the options, numbered as the lead will pick them. */
export function optionsSentence(
  options: Date[],
  type: MeetingType,
  propertyCode: string | null,
  timeZone: string,
): string {
  const list = options.map((at, index) => `${index + 1}) ${slotLabel(at, timeZone)}`).join(" · ");
  const pick = options.length === 1 ? "Esse horário fica bom?" : "Qual fica melhor?";
  return `Tenho estes horários para ${what(type, propertyCode)} com ${WHO}: ${list}. ${pick}`;
}

/** FR-006: the booking, confirmed. The widget also renders it as a card. */
export function confirmationSentence(
  at: Date,
  type: MeetingType,
  propertyCode: string | null,
  timeZone: string,
): string {
  const kind =
    type === "call" ? "Sua conversa por telefone" : propertyCode === null ? "Sua visita" : `Sua visita ao ${propertyCode}`;
  return `Pronto! ${kind} está confirmada para ${slotLabel(at, timeZone)}, com ${WHO}.`;
}

/**
 * FR-001 as amended: no times, no invented calendar, and no handoff on the
 * agent's own initiative. A lead who wants a person asks for one.
 */
export const NO_OPTIONS_SENTENCE =
  "No momento não tenho horários disponíveis na agenda. Se quiser, posso tentar de novo mais tarde.";

/** FR-005b: nothing matches the lead's constraint; an earlier proposal stays open. */
export const NO_OPTIONS_FOR_CONSTRAINT_SENTENCE = "Nesse dia e horário não tenho disponibilidade.";

/** FR-005a: reversible, so a decline the model misread costs one sentence, not the booking. */
export const DECLINE_ACKNOWLEDGEMENT = "Sem problema — se quiser marcar depois, é só pedir.";

/** FR-005b: a request before the script is complete. The script's question follows it. */
export const DETAILS_FIRST_SENTENCE = "Claro! Assim que eu tiver seus dados, te passo os horários.";

/**
 * FR-005e: asked who will attend. Neither a name nor a guess — the team
 * calendar is internal and who goes can change at the last minute.
 */
export const ATTENDEE_UNKNOWN_SENTENCE =
  "Ainda não consigo te dizer o nome de quem vai te atender, mas está tudo registrado no sistema com alguém da nossa equipe.";

/**
 * FR-004e: a visit is about a property. With cards on screen and none pointed
 * at, the lead is asked which — and offered the phone instead.
 */
export const VISIT_NEEDS_PROPERTY_SENTENCE =
  "Para marcar uma visita, me diz qual imóvel te interessou: é só tocar em Interessado no card ou me mandar o código. " +
  "Se preferir, também posso marcar uma conversa por telefone com alguém da nossa equipe.";

/** FR-004e: a visit asked for before any property was shown — the phone is what there is. */
export const NO_PROPERTY_YET_SENTENCE = "Ainda não tenho um imóvel para te levar, mas dá para conversar por telefone.";

/** FR-005h: the one format besides a visit, offered after an unsupported one. */
export const PHONE_OFFER_SENTENCE = "Se quiser, posso marcar uma conversa por telefone com alguém da nossa equipe.";

/** FR-005: why a pick could not be booked, said before the fresh options. */
export const BOOKING_REFUSED: Record<"too_soon" | "unavailable" | "collision" | "no_such_option", string> = {
  too_soon: "Esse horário está muito em cima.",
  unavailable: "Nesse horário não temos agenda.",
  collision: "Esse horário acabou de ser ocupado.",
  no_such_option: "Não encontrei essa opção na lista.",
};

/**
 * The action loop's instructions for a booking turn. The loop sees no
 * conversation, only this — so it carries the offered list with the exact date
 * and time of each, today's date, and what the lead wrote. The model maps "a
 * segunda" or "quinta às 11" onto `optionIndex`, or onto `date` + `time`.
 */
export function bookingBriefing(
  offered: Date[],
  leadText: string,
  now: Date,
  timeZone: string,
  /** Spec 009 reuses the same briefing for `rescheduleMeeting`. */
  toolName: "bookMeeting" | "rescheduleMeeting" = "bookMeeting",
): string {
  const iso = (at: Date) => {
    const local = localParts(at, timeZone);
    const hh = String(Math.floor(local.minutes / 60)).padStart(2, "0");
    const mm = String(local.minutes % 60).padStart(2, "0");
    return `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")} ${hh}:${mm}`;
  };
  const today = localParts(now, timeZone);
  const lines = offered.map((at, index) => `${index + 1}) ${slotLabel(at, timeZone)} (${iso(at)})`);
  // The next seven days, computed here: a 4-bit model reading "segunda" picked
  // the Monday that had already passed. Code does the calendar; the model only
  // looks the day up.
  const week = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(now.getTime() + (index + 1) * 24 * 60 * 60_000);
    return `${WEEKDAY[localParts(day, timeZone).weekday]} = ${iso(day).slice(0, 10)}`;
  });
  return [
    `Hoje é ${WEEKDAY[today.weekday]} ${iso(now).slice(0, 10)}.`,
    `Próximos dias: ${week.join(" · ")}. Um dia da semana dito pela pessoa é sempre o próximo desta lista, nunca um que já passou.`,
    ...(lines.length > 0 ? ["Horários oferecidos à pessoa:", ...lines] : ["Nenhum horário foi oferecido nesta conversa."]),
    `A pessoa escreveu: "${leadText}"`,
    ...(lines.length > 0 ? [`Se ela escolheu um desses horários, chame ${toolName} com optionIndex.`] : []),
    `Se ela disse outro dia e hora, chame ${toolName} com date (AAAA-MM-DD) e time (HH:MM).`,
    `Se ela não escolheu horário, não chame ${toolName}.`,
  ].join("\n");
}

/** FR-005b: a constraint nothing satisfies, with the earlier options still standing. */
export function stillValidSentence(options: Date[], timeZone: string): string {
  const list = options.map((at, index) => `${index + 1}) ${slotLabel(at, timeZone)}`).join(" · ");
  return `Os horários que te passei continuam valendo: ${list}. Algum deles serve?`;
}

// ---------------------------------------------------------------------------
// Spec 009: changing what was booked — code-written, like everything above
// ---------------------------------------------------------------------------

export interface MeetingRef {
  id: string;
  scheduledAt: Date;
  type: MeetingType;
  propertyCode: string | null;
}

/** "a visita ao VMA-0001" · "a conversa por telefone" */
function theMeeting(meeting: Pick<MeetingRef, "type" | "propertyCode">): string {
  if (meeting.type === "call") return "a conversa por telefone";
  return meeting.propertyCode === null ? "a visita" : `a visita ao ${meeting.propertyCode}`;
}

/** Spec 009: asked before cancelling (answered 29/09). */
export function cancelQuestion(meeting: MeetingRef, timeZone: string): string {
  return `Quer mesmo cancelar ${theMeeting(meeting)} de ${slotLabel(meeting.scheduledAt, timeZone)}?`;
}

export function cancelledSentence(meeting: MeetingRef, timeZone: string): string {
  return `Pronto, cancelei ${theMeeting(meeting)} de ${slotLabel(meeting.scheduledAt, timeZone)}. Quer marcar outro dia?`;
}

export function keptSentence(meeting: MeetingRef, timeZone: string): string {
  return `Tudo certo, ${theMeeting(meeting)} de ${slotLabel(meeting.scheduledAt, timeZone)} continua marcada.`;
}

export function rescheduledSentence(at: Date, type: MeetingType, propertyCode: string | null, timeZone: string): string {
  const kind =
    type === "call" ? "Sua conversa por telefone" : propertyCode === null ? "Sua visita" : `Sua visita ao ${propertyCode}`;
  return `Pronto! ${kind} foi remarcada para ${slotLabel(at, timeZone)}, com alguém da nossa equipe.`;
}

/** "Qual delas: a visita ao VMA-0001 (sex 02/10 às 14h) ou a conversa por telefone (ter 29/09 às 10h)?" */
export function whichOneSentence(meetings: MeetingRef[], timeZone: string): string {
  const items = meetings.map((meeting) => `${theMeeting(meeting)} (${slotLabel(meeting.scheduledAt, timeZone)})`);
  const list = items.length === 2 ? items.join(" ou ") : `${items.slice(0, -1).join(", ")} ou ${items.at(-1)}`;
  return `Qual delas: ${list}?`;
}

export function rescheduleOptionsSentence(meeting: MeetingRef, options: Date[], timeZone: string): string {
  const list = options.map((at, index) => `${index + 1}) ${slotLabel(at, timeZone)}`).join(" · ");
  return `Para remarcar ${theMeeting(meeting)}, tenho estes horários: ${list}. Qual fica melhor?`;
}

export const MEETING_LIMIT_SENTENCE =
  "Você já tem três compromissos marcados, que é o máximo por aqui. Se quiser, posso cancelar ou remarcar um deles.";

/** Spec 009: nothing still to come — maybe it already passed. A yes books a new one. */
export const NO_MEETING_TO_CHANGE_SENTENCE =
  "Não tenho nenhuma visita ou conversa marcada com você daqui pra frente. Quer marcar uma?";

/**
 * Spec 015: what is booked, as the close's code-written half. The model writes
 * the courtesy after it. Restating the meetings is a fact, so it is never left
 * to a sampler: left alone, "obrigado" got "vou atualizar o seu cadastro" and
 * "vou encaminhar para a equipe", next steps nobody takes.
 */
export function closingSummary(meetings: MeetingRef[], timeZone: string): string {
  const items = meetings.map((meeting) => `${theMeeting(meeting)} (${slotLabel(meeting.scheduledAt, timeZone)})`);
  return `Fica marcado: ${items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} e ${items.at(-1)}`}.`;
}

/**
 * Spec 009: the close, all in code. Spec 015 phrases the courtesy instead, and
 * this is what goes out when that phrasing fails or a guard throws it away.
 */
export function closingSentence(
  meetings: MeetingRef[],
  leadText: string,
  timeZone: string,
  /** The last reply already closed: say it short, without the summary again. */
  again = false,
): string {
  const thanked = /^\s*(muito\s+)?(obrigad|valeu|agradec)/iu.test(leadText);
  const open = thanked ? "Por nada!" : "Combinado!";
  if (again || meetings.length === 0) return `${open} Se precisar de algo, é só chamar.`;
  return `${open} ${closingSummary(meetings, timeZone)} Se precisar de algo, é só chamar.`;
}

/**
 * Spec 015: the offer, when the phrased one fails or a guard throws it away.
 * It names nothing the lead said, so it is safe for any remainder.
 */
export const BOUNDARY_OFFER_QUESTION = "Quer que alguém da nossa equipe verifique isso pra você?";

export const BOUNDARY_FALLBACK_SENTENCE = `Isso eu não consigo garantir por aqui. ${BOUNDARY_OFFER_QUESTION}`;
