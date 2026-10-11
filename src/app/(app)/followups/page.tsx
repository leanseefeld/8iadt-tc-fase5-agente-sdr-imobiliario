import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/core/auth";
import { getConfig } from "@/core/config";
import { localParts } from "@/domain/scheduling";
import { scopeForUser } from "@/services/auth";
import { listQueue, type QueueRow } from "@/services/followup-queue";
import { QueueItem, type QueueItemData } from "./_components/QueueItem";
import styles from "./followups.module.css";

/**
 * `/followups` — what goes out next (spec 017, backlog item 23).
 *
 * Constitution X: a broker or the manager came to see which messages are
 * about to reach leads, and to step in. Each row says when, to whom and what
 * kind, with one primary action (*Enviar agora*) and a quiet *Cancelar*. The
 * message itself is not shown: a follow-up is composed when it is sent.
 *
 * A broker starts on their own leads, like `/leads`; `?mine=0` shows the agency.
 */

export const dynamic = "force-dynamic";

const WEEKDAY: Record<string, string> = { mon: "seg", tue: "ter", wed: "qua", thu: "qui", fri: "sex", sat: "sáb", sun: "dom" };

function clock(at: Date, timeZone: string): string {
  const local = localParts(at, timeZone);
  const hours = Math.floor(local.minutes / 60);
  const minutes = local.minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function day(at: Date, timeZone: string): string {
  const local = localParts(at, timeZone);
  return `${WEEKDAY[local.weekday]} ${String(local.day).padStart(2, "0")}/${String(local.month).padStart(2, "0")}`;
}

function toItem(row: QueueRow, timeZone: string, later: boolean, now: Date): QueueItemData {
  const meetingAt = row.meeting === null ? null : `${day(row.meeting.scheduledAt, timeZone)} às ${clock(row.meeting.scheduledAt, timeZone)}`;
  const what =
    row.meeting === null
      ? null
      : row.meeting.type === "call"
        ? `Conversa por telefone · ${meetingAt}`
        : `Visita${row.meeting.propertyCode ? ` ao ${row.meeting.propertyCode}` : ""} · ${meetingAt}`;
  const waits = row.kind === "followup" && row.goesAt.getTime() > Math.max(row.dueAt.getTime(), now.getTime());
  return {
    jobId: row.jobId,
    kind: row.kind,
    time: clock(row.goesAt, timeZone),
    day: later ? day(row.goesAt, timeZone) : null,
    leadId: row.leadId,
    leadName: row.leadName,
    label: row.kind === "reminder" ? "Lembrete" : `Follow-up ${row.attempt} de ${row.maxAttempts}`,
    detail: row.kind === "reminder" ? what : row.previewLine,
    waitingNote: waits ? `Fora da janela de envio · sai ${later ? day(row.goesAt, timeZone) + " " : ""}às ${clock(row.goesAt, timeZone)}` : null,
    overdue: row.goesAt.getTime() <= now.getTime(),
    blocker: row.blocker,
  };
}

export default async function FollowupsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const scope = scopeForUser(session);
  const mineRaw = (await searchParams).mine;
  const mine = mineRaw === undefined ? scope.defaultOwnLeadsOnly : mineRaw === "1";
  const now = new Date();
  const timeZone = getConfig().FOLLOWUP_TIMEZONE;
  const groups = await listQueue(scope, mine ? { ownerId: session.userId } : {}, now);
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>Follow-ups</h1>
          <nav className={styles.toggle} aria-label="Escopo">
            <Link href="/followups?mine=1" aria-current={mine ? "page" : undefined} className={mine ? styles.toggleOn : styles.toggleLink}>
              Meus leads
            </Link>
            <Link href="/followups?mine=0" aria-current={!mine ? "page" : undefined} className={!mine ? styles.toggleOn : styles.toggleLink}>
              Toda a agência
            </Link>
          </nav>
        </div>
        <p className={styles.subtitle}>
          {total === 0 ? "Nada na fila" : total === 1 ? "1 mensagem na fila" : `${total} mensagens na fila`} · follow-ups
          são escritos pela Sofia na hora do envio; lembretes saem antes de cada visita ou conversa marcada
        </p>
      </header>

      {total === 0 ? (
        <div className={styles.empty}>
          <p>Nenhuma mensagem na fila.</p>
          <p>
            Um follow-up entra aqui quando um lead para de responder; um lembrete, quando uma visita ou conversa é
            confirmada.
          </p>
        </div>
      ) : (
        groups.map((group) => (
          <section key={group.label} className={styles.day} aria-labelledby={`grupo-${group.label}`}>
            <h2 id={`grupo-${group.label}`} className={styles.dayTitle}>
              {group.label}
            </h2>
            <ul className={styles.list}>
              {group.rows.map((row) => (
                <QueueItem key={row.jobId} row={toItem(row, timeZone, group.label === "Depois", now)} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
