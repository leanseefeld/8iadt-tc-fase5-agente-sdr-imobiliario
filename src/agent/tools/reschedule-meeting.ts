import { tool } from "ai";
import { z } from "zod";
import { createLogger } from "../../core/logging.ts";
import { rescheduleAppointment, type RescheduleResult } from "../../services/scheduling.ts";
import { indexFrom, instantFrom } from "./book-meeting.ts";
import type { ToolRefusal } from "./search-properties.ts";

const log = createLogger("app", { module: "agent/tools/reschedule-meeting" });

/**
 * `rescheduleMeeting` — spec 009: move a meeting the lead already has to the
 * time they chose. The same contract as `bookMeeting` (when to call, when not,
 * a readable refusal), and the same rule behind it: the service re-validates
 * with `checkSlot` and moves the same appointment row. Which meeting comes from
 * the turn, never from an argument.
 */

export interface RescheduleContext {
  appointmentId: string;
  /** Times offered for this move, when there were any, in the order the lead saw them. */
  offered: Date[];
  timezone: string;
  now?: Date;
  onRescheduled?: (result: RescheduleResult) => void;
}

const REFUSAL_MESSAGE: Record<string, string> = {
  gone: "Esse compromisso não está mais marcado. Não chame de novo.",
  no_such_option: "Esse número não está na lista oferecida.",
  missing_choice: "Informe optionIndex, ou date e time.",
  too_soon: "Horário perto demais de agora.",
  unavailable: "Fora da agenda do time.",
  collision: "Horário já ocupado.",
  failed: "A remarcação falhou. Não invente confirmação.",
};

function refusal(reason: string): ToolRefusal {
  return { ok: false, reason, message: REFUSAL_MESSAGE[reason] ?? REFUSAL_MESSAGE.failed };
}

export function rescheduleMeetingTool(context: RescheduleContext) {
  return tool({
    description:
      "Muda para outro horário uma visita ou conversa que a pessoa JÁ tem marcada. " +
      "Quando chamar: a pessoa escolheu um dos horários oferecidos para remarcar (optionIndex, contando a partir de 1) " +
      "ou disse o novo dia e hora (date AAAA-MM-DD e time HH:MM). " +
      "Quando NÃO chamar: ela não disse para quando mudar, quer cancelar, ou está falando de outra coisa. " +
      "Se ok for false, leia o motivo e não diga que remarcou.",
    inputSchema: z.object({
      optionIndex: z.union([z.number(), z.string()]).nullish(),
      date: z.string().nullish(),
      time: z.string().nullish(),
    }),
    execute: async (input) => {
      let choice: { optionIndex: number } | { scheduledAt: Date };
      const index = indexFrom(input.optionIndex);
      if (index !== null) {
        choice = { optionIndex: index };
      } else if (input.date != null && input.time != null) {
        const at = instantFrom(input.date, input.time, context.timezone);
        if (at === null) return refusal("missing_choice");
        choice = { scheduledAt: at };
      } else {
        return refusal("missing_choice");
      }
      try {
        const result = await rescheduleAppointment({
          appointmentId: context.appointmentId,
          choice,
          offered: context.offered,
          ...(context.now === undefined ? {} : { now: context.now }),
        });
        context.onRescheduled?.(result);
        if (!result.ok) return refusal(result.reason);
        return { ok: true as const, scheduledAt: result.scheduledAt.toISOString(), type: result.type };
      } catch (error) {
        log.warn({ err: (error as Error).message }, "reschedule tool failed");
        return refusal("failed");
      }
    },
  });
}
