import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getSession } from "@/core/auth";
import { getSessionUser } from "@/services/auth";
import { logoutAction } from "./actions";
import { Nav } from "./Nav";
import styles from "./shell.module.css";

const ROLE_LABEL: Record<"broker" | "salesManager", string> = {
  broker: "Corretor",
  salesManager: "Gerente comercial",
};

/**
 * Shell for every authenticated route (`/leads`, `/agenda`, `/catalogo`).
 * Constitution X: the person here is mid-task, moving between sections —
 * they need to know where they are (`Nav`'s `aria-current`) and who they are
 * signed in as (name + role badge, together) at a glance. "sair" is a
 * secondary control on purpose: it is rare, so it must not compete visually
 * with the three links a broker actually uses all day.
 *
 * `getSession()` is checked again here even though a request guard also
 * covers these routes (FR-008/009) — defence in depth, so this layout never
 * renders a shell with no user behind it.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const user = await getSessionUser(session);
  if (!user) redirect("/login"); // the session is signed but the row is gone — treat as unauthenticated

  return (
    <div className={styles.shell}>
      <header className={styles.topBar}>
        <span className={styles.brand}>SDR Imobiliário</span>
        <Nav />
        <div className={styles.identity}>
          <span className={styles.userName}>{user.name}</span>
          <span className={styles.roleBadge}>{ROLE_LABEL[user.role]}</span>
          <form action={logoutAction}>
            <button type="submit" className={styles.logoutButton}>
              sair
            </button>
          </form>
        </div>
      </header>
      <main className={styles.content}>{children}</main>
    </div>
  );
}
