"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { buildHref } from "./query";
import styles from "../leads.module.css";

const LIST_REGION_ID = "leads-list-region";

/**
 * FR-026, FR-031, SC-010: the panel's chrome only — focus, Escape, `inert`
 * on the list behind it, 420 px on desktop / full screen below 768 px (CSS).
 * `LeadPanel` renders the sections; this component never reads `LeadDetail`.
 *
 * Opening the panel is a normal navigation (the row's `<Link href="?lead=…">`
 * pushes a history entry), so the browser's back button already closes it —
 * Escape and the close button reuse the exact same mechanism, dropping
 * `lead` from the query string, so both paths behave identically.
 */
export function LeadDrawer({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<() => void>(() => {});

  closeRef.current = () => {
    const params = Object.fromEntries(searchParams.entries());
    router.push(buildHref(pathname, params, { lead: undefined }));
  };

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    const listRegion = document.getElementById(LIST_REGION_ID);
    listRegion?.setAttribute("inert", "");

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
    }
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      listRegion?.removeAttribute("inert");
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <div className={styles.drawerOverlay} onClick={() => closeRef.current()}>
      <div
        ref={panelRef}
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-label="Detalhes do lead"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className={styles.drawerClose}
          onClick={() => closeRef.current()}
          aria-label="Fechar painel"
        >
          Fechar
        </button>
        {children}
      </div>
    </div>
  );
}
