import Link from "next/link";
import { LEAD_FILTERS, type LeadFilter } from "@/services/leads";
import { buildHref, type SearchParamsRecord } from "./query";
import styles from "../leads.module.css";

const FILTER_LABEL: Record<LeadFilter, string> = {
  todos: "Todos",
  ao_vivo: "Ao vivo",
  aguardando: "Aguardando corretor",
  visita_marcada: "Visita marcada",
  sem_resposta: "Sem resposta",
};

/**
 * FR-020: plain links carrying the filter in `filtro` — no client JS, so the
 * choice survives a reload and the back button for free. Changing filter
 * resets `page`, never `q` or `mine`.
 */
export function FilterChips({
  current,
  params,
}: {
  current: LeadFilter;
  params: SearchParamsRecord;
}) {
  return (
    <nav className={styles.filterChips} aria-label="Filtrar leads">
      {LEAD_FILTERS.map((filter) => {
        const active = current === filter;
        const href = buildHref("/leads", params, {
          filtro: filter === "todos" ? undefined : filter,
          page: undefined,
        });
        return (
          <Link
            key={filter}
            href={href}
            aria-current={active ? "page" : undefined}
            className={active ? `${styles.chip} ${styles.chipActive}` : styles.chip}
          >
            {FILTER_LABEL[filter]}
          </Link>
        );
      })}
    </nav>
  );
}
