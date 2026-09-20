import styles from "../leads.module.css";

/** FR-021: `lastLeadMessageAt` within `DASHBOARD_LIVE_WINDOW_MINUTES`. Colour and word, like temperature. */
export function LiveDot() {
  return (
    <span className={styles.liveDot}>
      <span className={styles.liveDotMark} aria-hidden="true" />
      Ao vivo
    </span>
  );
}
