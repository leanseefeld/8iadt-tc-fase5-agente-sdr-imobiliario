import type { LeadStage } from "@/domain/lead-status";
import type { Intent, SlotKey } from "@/domain/slots";
import type { Temperature } from "@/domain/score";

/**
 * Every pt-BR vocabulary the queue and the panel share, in one place, so
 * "Ana moveu para Qualificado" and the stage chip never disagree on the word
 * for `qualified`.
 */

export const TEMPERATURE_LABEL: Record<Temperature, string> = {
  hot: "Quente",
  warm: "Morno",
  cold: "Frio",
};

export const INTENT_LABEL: Record<Intent, string> = {
  purchase: "Compra",
  rental: "Aluguel",
  investment: "Investimento",
  undefined: "Intenção ainda não identificada",
};

export const STAGE_LABEL: Record<LeadStage, string> = {
  new: "Novo",
  qualifying: "Qualificando",
  qualified: "Qualificado",
  // The stage, not the meeting: *Visita marcada* is the filter derived from a
  // confirmed future appointment (spec 006 FR-008b). A lead whose meeting was
  // cancelled stays at this stage, and must not read as having one booked.
  scheduled: "Agendamento feito",
  visited: "Visitado",
  won: "Ganho",
  lost: "Perdido",
};

export const SLOT_LABEL: Record<SlotKey, string> = {
  priceMax: "orçamento",
  bedrooms: "número de quartos",
  neighborhoods: "bairros",
  urgency: "prazo",
  investorProfile: "perfil de investidor",
  ticket: "valor de investimento",
  returnExpectation: "expectativa de retorno",
  name: "nome",
  contact: "contato",
};

export const SLOT_QUESTION_LABEL: Record<SlotKey, string> = {
  priceMax: "Orçamento",
  bedrooms: "Quartos",
  neighborhoods: "Bairros",
  urgency: "Prazo",
  investorProfile: "Perfil de investidor",
  ticket: "Valor de investimento",
  returnExpectation: "Expectativa de retorno",
  name: "Nome",
  contact: "Contato",
};

export const URGENCY_LABEL: Record<string, string> = {
  immediate: "Imediata",
  soon: "Em breve",
  exploring: "Pesquisa inicial",
};

export const INVESTOR_PROFILE_LABEL: Record<string, string> = {
  firstTime: "Primeira aplicação",
  experienced: "Investidor experiente",
};

export const RETURN_EXPECTATION_LABEL: Record<string, string> = {
  income: "Renda",
  appreciation: "Valorização",
  both: "Renda e valorização",
  undecided: "Indeciso",
};
