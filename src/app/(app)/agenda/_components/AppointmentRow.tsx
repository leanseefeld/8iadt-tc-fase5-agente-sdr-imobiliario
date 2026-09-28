"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { markCancelled, markDone } from "../actions";
import styles from "../agenda.module.css";

export interface AppointmentRowData {
  id: string;
  time: string;
  leadId: string;
  leadName: string | null;
  type: "viewing" | "call";
  propertyCode: string | null;
  neighborhood: string | null;
  status: "confirmed" | "done" | "cancelled";
  brokerName: string | null;
}

const STATUS_LABEL: Record<AppointmentRowData["status"], string> = {
  confirmed: "Confirmada",
  done: "Realizada",
  cancelled: "Cancelada",
};

/**
 * One meeting, read left to right the way a broker checks a day: when, who,
 * what, where. The two actions only exist while the meeting is still ahead of
 * them, and each says what it did.
 */
export function AppointmentRow({ row }: { row: AppointmentRowData }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  function run(action: (id: string) => ReturnType<typeof markDone>, done: string): void {
    startTransition(async () => {
      const result = await action(row.id);
      setMessage(result.ok ? { text: done, error: false } : { text: result.message, error: true });
      if (result.ok) router.refresh();
    });
  }

  const what =
    row.type === "call"
      ? "Conversa por telefone"
      : row.propertyCode === null
        ? "Visita"
        : `Visita · ${row.propertyCode}${row.neighborhood ? `, ${row.neighborhood}` : ""}`;

  return (
    <li className={styles.row} data-status={row.status}>
      <span className={styles.time}>{row.time}</span>
      <div className={styles.body}>
        <Link className={styles.lead} href={`/leads?mine=0&lead=${row.leadId}`}>
          {row.leadName ?? "Lead sem nome"}
        </Link>
        <span className={styles.what}>{what}</span>
        {row.brokerName !== null && <span className={styles.broker}>{row.brokerName}</span>}
      </div>
      <div className={styles.side}>
        <span className={styles.status} data-status={row.status}>
          {STATUS_LABEL[row.status]}
        </span>
        {row.status === "confirmed" && (
          <div className={styles.actions}>
            <button type="button" className={styles.action} disabled={pending} onClick={() => run(markDone, "Marcada como realizada.")}>
              Realizada
            </button>
            <button
              type="button"
              className={`${styles.action} ${styles.actionQuiet}`}
              disabled={pending}
              onClick={() => run(markCancelled, "Cancelada.")}
            >
              Cancelar
            </button>
          </div>
        )}
        {message && (
          <span role="status" className={message.error ? styles.messageError : styles.message}>
            {message.text}
          </span>
        )}
      </div>
    </li>
  );
}
