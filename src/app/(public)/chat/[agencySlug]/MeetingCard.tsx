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
  const longDay = new Intl.DateTimeFormat("pt-BR", { timeZone, weekday: "long", day: "2-digit", month: "2-digit" }).format(at);
  // "Segunda-feira", not CSS capitalize's "Segunda-Feira".
  const day = longDay.charAt(0).toUpperCase() + longDay.slice(1);
  const [hours, minutes] = new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(at)
    .split(":")
    .map(Number);
  // "10h", "16h30" — the same spelling as the confirmation sentence above it.
  const time = minutes === 0 ? `${hours}h` : `${hours}h${String(minutes).padStart(2, "0")}`;
  const what =
    booking.type === "call"
      ? "Conversa por telefone"
      : booking.propertyCode === null
        ? "Visita"
        : `Visita ao ${booking.propertyCode}`;

  return (
    <article className={styles.meetingCard} aria-label={`${what}, ${day} às ${time}`}>
      <p className={styles.meetingLabel}>Agendado</p>
      <p className={styles.meetingWhen}>
        {day} · {time}
      </p>
      <p className={styles.meetingWhat}>{what}</p>
    </article>
  );
}
