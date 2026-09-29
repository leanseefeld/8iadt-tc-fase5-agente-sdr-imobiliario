import { redirect } from "next/navigation";
import { getSession } from "@/core/auth";
import { getConfig } from "@/core/config";
import { localParts, zonedInstant } from "@/domain/scheduling";
import { listAppointments } from "@/services/scheduling";
import { AppointmentRow } from "./_components/AppointmentRow";
import styles from "./agenda.module.css";

/**
 * `/agenda` — the day's meetings (spec 006 US3, FR-007, FR-008).
 *
 * Constitution X: the broker opens this to know what today holds, so today is
 * first and alone at the top, the next two weeks follow, and each row reads at
 * 390 px without a table. A broker sees their own meetings; a manager, the
 * agency's, each with who attends.
 */

export const dynamic = "force-dynamic";

const DAYS_AHEAD = 14;

export default async function AgendaPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const timeZone = getConfig().FOLLOWUP_TIMEZONE;
  const now = new Date();
  const today = localParts(now, timeZone);
  const from = zonedInstant(today.year, today.month, today.day, 0, timeZone);
  const to = new Date(from.getTime() + DAYS_AHEAD * 24 * 60 * 60_000);

  const manager = session.role === "salesManager";
  const groups = await listAppointments(
    { agencyId: session.agencyId, userId: session.userId, role: session.role },
    { from, to },
    now,
  );

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Agenda</h1>
        <p className={styles.subtitle}>
          {manager ? "Visitas e conversas da imobiliária" : "Suas visitas e conversas"} · hoje e próximos {DAYS_AHEAD} dias
        </p>
      </header>

      {groups.length === 0 ? (
        <div className={styles.empty}>
          <p>Nenhum compromisso marcado por enquanto.</p>
          <p>
            Quando um lead escolhe um horário na conversa com o agente, a visita ou a conversa aparece aqui, no dia
            certo.
          </p>
        </div>
      ) : (
        groups.map((group) => (
          <section key={group.day} className={styles.day} aria-labelledby={`day-${group.day}`}>
            <h2 id={`day-${group.day}`} className={styles.dayTitle}>
              {group.label}
            </h2>
            <ul className={styles.list}>
              {group.rows.map((row) => (
                <AppointmentRow
                  key={row.id}
                  row={{
                    id: row.id,
                    time: row.time,
                    leadId: row.leadId,
                    leadName: row.leadName,
                    type: row.type,
                    propertyCode: row.propertyCode,
                    neighborhood: row.neighborhood,
                    status: row.status,
                    brokerName: manager ? row.brokerName : null,
                  }}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
