"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./shell.module.css";

const LINKS = [
  { href: "/leads", label: "Leads" },
  { href: "/agenda", label: "Agenda" },
  { href: "/catalogo", label: "Catálogo" },
];

/**
 * Constitution X: the current section must be visibly selected, not merely
 * hoverable, so orientation is immediate. `usePathname` needs a client
 * component, but the markup it renders — plain `<Link>`s with `aria-current`
 * on the active one — is identical to what a server render would produce, so
 * this still works with JavaScript disabled (the links just navigate).
 */
export function Nav() {
  const pathname = usePathname();

  return (
    <nav className={styles.nav} aria-label="Navegação principal">
      {LINKS.map(({ href, label }) => {
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
