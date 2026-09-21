import type { LeadStage } from "@/domain/lead-status";
import { STAGE_LABEL } from "./labels";
import styles from "../leads.module.css";

/**
 * FR-021: the pipeline stage. The *Visita `<dia> <hora>`* variant of
 * `modelo-de-dados.md` §7 needs a confirmed appointment, which lands with 006
 * — this chip always renders the plain stage name today.
 */
export function StageChip({ stage }: { stage: LeadStage }) {
  return <span className={`${styles.chip} ${styles.stageChip}`}>{STAGE_LABEL[stage]}</span>;
}
