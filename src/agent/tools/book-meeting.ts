import { tool } from "ai";
import { z } from "zod";
import { createLogger } from "../../core/logging.ts";
import { zonedInstant } from "../../domain/scheduling.ts";
import { bookAppointment, type BookResult } from "../../services/scheduling.ts";
import type { ToolRefusal } from "./search-properties.ts";

const log = createLogger("app", { module: "agent/tools/book-meeting" });

/**
 * `bookMeeting` — the one scheduling action the model takes (spec 006 FR-005).
 *
 * Proposing is code's; this books a time the lead chose. The contract follows
 * spec 007 FR-013a: when to call and when not to, stated in the description; a
 * narrow schema; a refusal the model can read. Conversation, agency and the
 * offered times come from the turn, never from arguments (FR-014), and the time
 * is re-validated by the same rule that produced the options.
 */

export interface BookingContext {
  conversationId: string;
  /** The times the latest options message offered, in the order the lead saw them. */
  offered: Date[];
  timezone: string;
  now?: Date;
  /** The turn collects the outcome. Not a model argument. */
  onBooked?: (result: BookResult) => void;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** "10:00", "9:30", "10h", "10h30" — the 4-bit model writes all of them. */
const TIME = /^(\d{1,2})(?:[:h](\d{2})?)?$/;

/** The lead's own day and time, in the agency's timezone. */
export function instantFrom(date: string, time: string, timezone: string): Date | null {
  const clock = TIME.exec(time.trim());
  if (!DATE.test(date.trim()) || clock === null) return null;
  const hours = Number(clock[1]);
  const minutes = Number(clock[2] ?? 0);
  if (hours > 23 || minutes > 59) return null;
  const [year, month, day] = date.trim().split("-").map(Number);
  return zonedInstant(year, month, day, hours * 60 + minutes, timezone);
}

/** The model sends `2` or `"2"`; both are the second option. Anything else is no index. */
export function indexFrom(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const index = typeof value === "number" ? value : Number(value.trim());
  return Number.isInteger(index) && index > 0 ? index : null;
}

const REFUSAL_MESSAGE: Record<string, string> = {
  no_proposal: "Não há proposta de horário aberta. Não chame de novo.",
  no_such_option: "Esse número não está na lista oferecida.",
  missing_choice: "Informe optionIndex, ou date e time.",
  too_soon: "Horário perto demais de agora.",
  unavailable: "Fora da agenda do time.",
  collision: "Horário já ocupado.",
  failed: "O agendamento falhou. Não invente confirmação.",
};

function refusal(reason: string): ToolRefusal {
  return { ok: false, reason, message: REFUSAL_MESSAGE[reason] ?? REFUSAL_MESSAGE.failed };
}

export function bookMeetingTool(context: BookingContext) {
  return tool({
    description:
      "Confirma um horário que a pessoa escolheu. " +
      "Quando chamar: há horários oferecidos e a pessoa escolheu um deles (use optionIndex, " +
      'contando a partir de 1: "a segunda" é 2) ou disse outro dia e hora (use date AAAA-MM-DD e time HH:MM). ' +
      "Quando NÃO chamar: a pessoa não escolheu horário, recusou, pediu outros horários ou está falando de outra coisa. " +
      "Se ok for false, leia o motivo e não diga que marcou.",
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
        const result = await bookAppointment({
          conversationId: context.conversationId,
          choice,
          offered: context.offered,
          ...(context.now === undefined ? {} : { now: context.now }),
        });
        context.onBooked?.(result);
        if (!result.ok) return refusal(result.reason);
        return { ok: true as const, scheduledAt: result.scheduledAt.toISOString(), type: result.type };
      } catch (error) {
        log.warn({ err: (error as Error).message }, "booking tool failed");
        return refusal("failed");
      }
    },
  });
}
