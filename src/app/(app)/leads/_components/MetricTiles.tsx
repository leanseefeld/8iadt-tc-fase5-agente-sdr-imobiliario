import type { FunnelMetrics } from "@/services/metrics";
import { formatDuration } from "./format";
import styles from "../leads.module.css";

/**
 * FR-018: four tiles, cumulative, above the list. A null median (no agent
 * reply recorded yet) reads "—"; the two tiles 006 fills — confirmed
 * appointments and recovered leads — read `0`, because that is the correct
 * number today rather than a missing feature (assumptions.md).
 *
 * The empty state below is the third of the panel's three (FR-025): with no
 * leads at all in the agency the tiles have nothing to summarise.
 */
export function MetricTiles({ metrics }: { metrics: FunnelMetrics }) {
  if (metrics.totalLeads === 0) {
    return (
      <p className={styles.tilesEmpty}>Ainda não há leads para calcular os indicadores.</p>
    );
  }

  const median =
    metrics.medianFirstResponseSeconds === null
      ? "—"
      : formatDuration(metrics.medianFirstResponseSeconds);
  const qualificationRate =
    metrics.qualificationRate === null ? "—" : `${Math.round(metrics.qualificationRate * 100)}%`;

  return (
    <dl className={styles.tiles}>
      <div className={styles.tile}>
        <dt className={styles.tileLabel}>Tempo médio de 1ª resposta</dt>
        <dd className={styles.tileValue}>{median}</dd>
      </div>
      <div className={styles.tile}>
        <dt className={styles.tileLabel}>Taxa de qualificação</dt>
        <dd className={styles.tileValue}>{qualificationRate}</dd>
      </div>
      <div className={styles.tile}>
        <dt className={styles.tileLabel}>Visitas confirmadas</dt>
        <dd className={styles.tileValue}>{metrics.confirmedAppointments}</dd>
      </div>
      <div className={styles.tile}>
        <dt className={styles.tileLabel}>Leads recuperados</dt>
        <dd className={styles.tileValue}>{metrics.recoveredLeads}</dd>
      </div>
    </dl>
  );
}
