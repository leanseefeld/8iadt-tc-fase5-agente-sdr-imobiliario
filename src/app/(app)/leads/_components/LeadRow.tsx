import Link from "next/link";
import type { LeadRow as LeadRowData } from "@/services/leads";
import { buildHref, type SearchParamsRecord } from "./query";
import { ConversationChip } from "./ConversationChip";
import { StageChip } from "./StageChip";
import { LiveDot } from "./LiveDot";
import { relativeTime, formatCurrency } from "./format";
import { TEMPERATURE_LABEL, INTENT_LABEL } from "./labels";
import styles from "../leads.module.css";

/** FR-021's "neighborhoods · price · bedrooms" line, in whatever order is known. */
function qualificationLine(row: LeadRowData): string {
  const parts: string[] = [];
  if (row.slots.neighborhoods && row.slots.neighborhoods.length > 0) {
    parts.push(row.slots.neighborhoods.join(", "));
  }
  if (row.slots.priceMax !== null) parts.push(formatCurrency(row.slots.priceMax));
  if (row.slots.bedrooms !== null) {
    parts.push(`${row.slots.bedrooms} ${row.slots.bedrooms === 1 ? "quarto" : "quartos"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "Qualificação em andamento";
}

export function LeadRow({
  row,
  params,
}: {
  row: LeadRowData;
  params: SearchParamsRecord;
}) {
  const href = buildHref("/leads", params, { lead: row.id });

  return (
    <li className={styles.row}>
      <Link href={href} className={styles.rowLink}>
        <span className={styles.tempGroup}>
          <span className={styles.tempDot} data-temp={row.temperature} aria-hidden="true" />
          <span className={styles.tempLabel}>{TEMPERATURE_LABEL[row.temperature]}</span>
        </span>

        <span className={styles.rowMain}>
          <span className={styles.rowTop}>
            <span className={styles.leadName}>{row.name ?? "Lead anônimo"}</span>
            <span className={styles.intentLabel}>{INTENT_LABEL[row.intent]}</span>
            {row.live && <LiveDot />}
          </span>
          <span className={styles.qualLine}>{qualificationLine(row)}</span>
          {row.previewLine && <span className={styles.previewLine}>&ldquo;{row.previewLine}&rdquo;</span>}
        </span>

        <span className={styles.rowChips}>
          <ConversationChip state={row.conversation} />
          <StageChip stage={row.stage} />
        </span>

        <span className={styles.rowTime}>
          {row.lastLeadMessageAt ? relativeTime(row.lastLeadMessageAt) : "—"}
        </span>
      </Link>
    </li>
  );
}
