import Link from "next/link";
import type { UserRole } from "@/core/auth";
import styles from "../leads.module.css";

/**
 * Spec 006 FR-019: whether the agency's automatic messages are on, in words.
 * The switch itself moved to /configuracoes (spec 017), so here it is a fact
 * for everyone, and a way there for the one person who can change it.
 */
export function FollowupStatus({ enabled, role }: { enabled: boolean; role: UserRole }) {
  return (
    <p className={styles.followupSwitch}>
      Follow-up automático: <strong>{enabled ? "ligado" : "desligado"}</strong>
      {role === "salesManager" && (
        <>
          {" · "}
          <Link href="/configuracoes">Alterar</Link>
        </>
      )}
    </p>
  );
}
