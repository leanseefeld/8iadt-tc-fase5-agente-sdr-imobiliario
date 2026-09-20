import type { ConversationState } from "@/services/leads";
import styles from "../leads.module.css";

/**
 * FR-021, FR-038: *Agente respondendo* · *<Nome> no comando* · *Aguardando
 * corretor* · *Encerrada* — the same four readings the panel and the
 * *Aguardando corretor* filter use, from `modelo-de-dados.md` §7.
 */
function label(state: ConversationState): string {
  switch (state.kind) {
    case "agent":
      return "Agente respondendo";
    case "held":
      return `${state.byName} no comando`;
    case "waiting":
      return "Aguardando corretor";
    case "closed":
      return "Encerrada";
  }
}

export function ConversationChip({ state }: { state: ConversationState }) {
  return (
    <span className={`${styles.chip} ${styles[`conversationChip_${state.kind}`]}`}>
      {label(state)}
    </span>
  );
}
