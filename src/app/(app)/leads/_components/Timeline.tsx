import type { PanelEvent } from "@/services/leads";
import { timelineSentence } from "./timelineSentence";
import { absoluteTime, relativeTime } from "./format";
import styles from "../leads.module.css";

/**
 * FR-030: pt-BR sentences naming the actor, newest first (as `getLeadDetail`
 * already orders them), with a "ver trace" link wherever an event carries a
 * `traceId` — read through `getConfig()`, no new key (plan.md's drift note).
 */
export function Timeline({
  events,
  langfuseUiPort,
}: {
  events: PanelEvent[];
  langfuseUiPort: number;
}) {
  if (events.length === 0) {
    return <p className={styles.helperText}>Nenhum evento registrado ainda.</p>;
  }

  return (
    <ul className={styles.timeline}>
      {events.map((event) => (
        <li key={event.id} className={styles.timelineItem}>
          <span className={styles.timelineDot} aria-hidden="true" />
          <span className={styles.timelineBody}>
            <span>{timelineSentence(event)}</span>
            <span className={styles.timelineTime} title={absoluteTime(event.createdAt)}>
              {relativeTime(event.createdAt)}
            </span>
            {event.traceId && (
              <a
                className={styles.traceLink}
                href={`http://localhost:${langfuseUiPort}`}
                target="_blank"
                rel="noreferrer"
              >
                ver trace
              </a>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
