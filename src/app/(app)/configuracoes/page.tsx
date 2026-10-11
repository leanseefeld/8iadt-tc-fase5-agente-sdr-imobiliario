import { redirect } from "next/navigation";
import { getSession } from "@/core/auth";
import { getAgencySettings, REMINDER_LEAD_CHOICES } from "@/services/agency-settings";
import { SettingsForm } from "./_components/SettingsForm";
import styles from "./configuracoes.module.css";

/**
 * `/configuracoes` — when the agency talks to leads (spec 017, backlog item 37).
 *
 * Constitution X: the sales manager came to change when automatic messages go
 * out. Two blocks, each led by its on/off switch — follow-ups with their
 * sending window, the meeting reminder with its lead time — and one Save.
 * A broker has nothing to do here and is sent to the leads.
 */

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "salesManager") redirect("/leads");

  const settings = await getAgencySettings(session.agencyId);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Configurações</h1>
        <p className={styles.subtitle}>Quando a Sofia pode mandar mensagens que o lead não pediu. Vale na hora, sem reiniciar nada.</p>
      </header>
      <SettingsForm initial={settings} leadChoices={[...REMINDER_LEAD_CHOICES]} />
    </div>
  );
}
