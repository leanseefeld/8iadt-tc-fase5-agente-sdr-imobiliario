import { SCRIPT, type Intent, type Slots, type SlotKey } from "@/domain/slots";
import { formatCurrency } from "./format";
import {
  INTENT_LABEL,
  INVESTOR_PROFILE_LABEL,
  RETURN_EXPECTATION_LABEL,
  SLOT_QUESTION_LABEL,
  URGENCY_LABEL,
} from "./labels";
import styles from "../leads.module.css";

const NOT_INFORMED = "— não informado";

function formatSlotValue(slot: SlotKey, slots: Slots): string {
  const value = slots[slot];

  switch (slot) {
    case "priceMax":
    case "ticket":
      return value === null ? NOT_INFORMED : formatCurrency(value as number);
    case "bedrooms":
      return value === null ? NOT_INFORMED : `${value as number}`;
    case "neighborhoods": {
      const list = value as string[] | null;
      if (list === null) return NOT_INFORMED;
      return list.length === 0 ? "Aberto a sugestões" : list.join(", ");
    }
    case "urgency":
      return value === null ? NOT_INFORMED : (URGENCY_LABEL[value as string] ?? String(value));
    case "investorProfile":
      return value === null
        ? NOT_INFORMED
        : (INVESTOR_PROFILE_LABEL[value as string] ?? String(value));
    case "returnExpectation":
      return value === null
        ? NOT_INFORMED
        : (RETURN_EXPECTATION_LABEL[value as string] ?? String(value));
    case "name":
    case "contact":
      return value === null ? NOT_INFORMED : String(value);
    default:
      return NOT_INFORMED;
  }
}

/**
 * FR-028: every slot of the lead's script, in script order — the intent
 * itself first, since it decides which script applies. An undefined intent
 * has no script yet, so the table has nothing beyond that first row.
 */
export function QualificationTable({ intent, slots }: { intent: Intent; slots: Slots }) {
  const script = SCRIPT[intent];

  return (
    <table className={styles.qualTable}>
      <tbody>
        <tr className={styles.qualRow}>
          <td className={styles.qualLabel}>Intenção</td>
          <td className={intent === "undefined" ? styles.qualValueEmpty : undefined}>
            {intent === "undefined" ? NOT_INFORMED : INTENT_LABEL[intent]}
          </td>
        </tr>
        {script.map((slot) => {
          const value = formatSlotValue(slot, slots);
          return (
            <tr key={slot} className={styles.qualRow}>
              <td className={styles.qualLabel}>{SLOT_QUESTION_LABEL[slot]}</td>
              <td className={value === NOT_INFORMED ? styles.qualValueEmpty : undefined}>
                {value}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
