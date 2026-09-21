import type { PanelEvent } from "@/services/leads";
import type { Intent, SlotKey } from "@/domain/slots";
import { isLeadStage } from "@/domain/lead-status";
import { INTENT_LABEL, SLOT_LABEL, STAGE_LABEL } from "./labels";

/**
 * FR-030: the timeline names the actor and reads as a pt-BR sentence, never a
 * raw event type — `modelo-de-dados.md` §4 is the catalog this switches on.
 * A type this code does not recognise (a future spec's event, or bad data)
 * degrades to a readable line instead of crashing the panel.
 */
export function timelineSentence(event: PanelEvent): string {
  const payload = event.payload;
  const actor = event.actorName;

  switch (event.type) {
    case "lead.created":
      return "Lead chegou pelo site";
    case "lead.consented":
      return "Lead autorizou o contato";
    case "intent.identified": {
      const intent = payload.intent;
      const label = typeof intent === "string" ? INTENT_LABEL[intent as Intent] : undefined;
      return `Agente identificou intenção: ${label ?? "não identificada"}`;
    }
    case "slot.filled": {
      const slot = payload.slot;
      const label = typeof slot === "string" ? SLOT_LABEL[slot as SlotKey] : undefined;
      return `Agente registrou ${label ?? "uma informação"}`;
    }
    case "conversation.turn":
      return "Agente respondeu ao lead";
    case "lead.qualified":
      return "Lead qualificado";
    case "properties.suggested":
      return "Agente sugeriu imóveis";
    case "handoff.requested":
      return payload.reason === "asked"
        ? "Lead pediu para falar com um corretor"
        : "Agente pediu apoio de um corretor";
    case "conversation.assumed":
      return `${actor ?? "Um corretor"} assumiu a conversa`;
    case "conversation.returned":
      return `${actor ?? "O corretor"} devolveu a conversa ao agente`;
    case "summary.updated":
      return "Resumo atualizado";
    case "appointment.proposed":
      return "Agente propôs um horário de visita";
    case "appointment.confirmed":
      return "Visita confirmada";
    case "appointment.done":
      return "Visita realizada";
    case "appointment.cancelled":
      return "Visita cancelada";
    case "followup.scheduled":
      return "Follow-up agendado";
    case "followup.sent":
      return "Follow-up enviado ao lead";
    case "followup.recovered":
      return "Lead voltou a responder após o follow-up";
    case "lead.opted_out":
      return "Lead pediu para não ser mais contatado";
    case "lead.status_changed": {
      const to = payload.to;
      const label = typeof to === "string" && isLeadStage(to) ? STAGE_LABEL[to] : String(to ?? "?");
      return `${actor ?? "Agente"} moveu para ${label}`;
    }
    case "lead.reassigned":
      return `${actor ?? "Um gerente"} transferiu o lead para outro corretor`;
    default:
      // Unknown types degrade to something readable rather than crash the panel.
      return `${actor ?? "Sistema"}: ${event.type.replace(/[._]/g, " ")}`;
  }
}
