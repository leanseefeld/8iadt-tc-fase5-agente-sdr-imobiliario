import Link from "next/link";
import { buildHref, type SearchParamsRecord } from "./query";
import styles from "../leads.module.css";

/**
 * FR-019: a UI default, not a permission — both roles get the same agency
 * query, "Meus leads" narrows it. Two plain links, so the toggle survives a
 * reload with no client JS (spec.md's "why a toggle" clarification).
 */
export function MeusLeadsToggle({
  mine,
  params,
}: {
  mine: boolean;
  params: SearchParamsRecord;
}) {
  return (
    <div className={styles.toggle} role="group" aria-label="Escopo dos leads">
      <Link
        href={buildHref("/leads", params, { mine: "1", page: undefined })}
        aria-current={mine ? "true" : undefined}
        className={mine ? `${styles.toggleLink} ${styles.toggleLinkActive}` : styles.toggleLink}
      >
        Meus leads
      </Link>
      <Link
        href={buildHref("/leads", params, { mine: "0", page: undefined })}
        aria-current={!mine ? "true" : undefined}
        className={!mine ? `${styles.toggleLink} ${styles.toggleLinkActive}` : styles.toggleLink}
      >
        Toda a agência
      </Link>
    </div>
  );
}
