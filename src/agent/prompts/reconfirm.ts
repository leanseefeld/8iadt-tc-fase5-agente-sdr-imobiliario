import type { SlotKey, Slots } from "../../domain/slots.ts";

/**
 * The reconfirmation, written rather than requested. One restatement, then
 * exactly one question (FR-008). pt-BR.
 *
 * "Só pra confirmar: até R$ 1,2 mi, 3 quartos, Moema. Continua assim?"
 */

function compactBrl(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    const rounded = Math.round(millions * 10) / 10;
    const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(".", ",");
    return `R$ ${text} mi`;
  }
  if (value % 1_000 === 0) return `R$ ${value / 1_000} mil`;
  return `R$ ${value.toLocaleString("pt-BR")}`;
}

const URGENCY: Record<string, string> = {
  immediate: "prazo imediato",
  soon: "prazo de até 3 meses",
  exploring: "sem prazo definido",
};

const PROFILE: Record<string, string> = {
  firstTime: "primeira aplicação",
  experienced: "já investe",
};

const RETURN: Record<string, string> = {
  income: "renda",
  appreciation: "valorização",
  both: "renda e valorização",
  undecided: "retorno em aberto",
};

function phrase(slot: SlotKey, slots: Slots): string | null {
  const value = slots[slot];
  if (value === null || value === undefined) return null;
  switch (slot) {
    case "priceMax":
    case "ticket":
      return `até ${compactBrl(value as number)}`;
    case "bedrooms": {
      const count = value as number;
      return count === 1 ? "1 quarto" : `${count} quartos`;
    }
    case "neighborhoods": {
      const list = value as string[];
      return list.length === 0 ? "aberto a sugestões" : list.join(" ou ");
    }
    case "urgency":
      return URGENCY[value as string] ?? String(value);
    case "investorProfile":
      return PROFILE[value as string] ?? String(value);
    case "returnExpectation":
      return RETURN[value as string] ?? String(value);
    default:
      return null;
  }
}

/** The sentence, or null when there is nothing filled to restate. */
export function reconfirmationSentence(slots: Slots, keys: SlotKey[]): string | null {
  const parts = keys.map((slot) => phrase(slot, slots)).filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  return `Só pra confirmar: ${parts.join(", ")}. Continua assim?`;
}
