"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./shell.module.css";

const LINKS = [
  { href: "/leads", label: "Leads" },
  { href: "/followups", label: "Follow-ups" },
  { href: "/agenda", label: "Agenda" },
  { href: "/catalogo", label: "Catálogo" },
];

// Spec 017: the agency's settings are a sales manager's alone.
const MANAGER_LINKS = [{ href: "/configuracoes", label: "Configurações" }];

/**
 * Constitution X: the current section must be visibly selected, not merely
 * hoverable, so orientation is immediate. `usePathname` needs a client
 * component, but the markup it renders — plain `<Link>`s with `aria-current`
 * on the active one — is identical to what a server render would produce, so
 * this still works with JavaScript disabled (the links just navigate).
 */
export function Nav({ manager }: { manager: boolean }) {
  const pathname = usePathname();
  const links = manager ? [...LINKS, ...MANAGER_LINKS] : LINKS;

  return (
    <nav className={styles.nav} aria-label="Navegação principal">
      {links.map(({ href, label }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            className={active ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink}
            aria-current={active ? "page" : undefined}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
