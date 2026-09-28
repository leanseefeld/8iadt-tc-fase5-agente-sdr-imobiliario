import type { WireBooking } from "@/app/api/chat/wire";
import styles from "./chat.module.css";

/**
 * A booked meeting under the confirmation that made it (spec 006 FR-006). The
 * sentence above already says it; the card is what the lead screenshots, so it
 * carries the same four facts in a form that scans: the day, the time, what it
 * is and — for a visit — which property. No broker: the lead was told "alguém
 * da nossa equipe" (FR-005e). Purely presentational, like `PropertyCard`.
 */
export default function MeetingCard({ booking, timeZone }: { booking: WireBooking; timeZone: string }) {
  const at = new Date(booking.scheduledAt);
  const day = new Intl.DateTimeFormat("pt-BR", { timeZone, weekday: "long", day: "2-digit", month: "2-digit" }).format(at);
  const time = new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit" }).format(at);
  const what =
    booking.type === "call"
      ? "Conversa com a equipe"
      : booking.propertyCode === null
        ? "Visita"
        : `Visita ao ${booking.propertyCode}`;

  return (
    <article className={styles.meetingCard} aria-label={`${what}, ${day} às ${time}`}>
      <p className={styles.meetingLabel}>Agendado</p>
      <p className={styles.meetingWhen}>
        <span className={styles.meetingDay}>{day}</span> · {time}
      </p>
      <p className={styles.meetingWhat}>{what}</p>
    </article>
  );
}
