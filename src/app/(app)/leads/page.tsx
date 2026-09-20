import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/core/auth";
import { scopeForUser } from "@/services/auth";
import { getFunnelMetrics } from "@/services/metrics";
import { isLeadFilter, listLeads, type LeadFilter } from "@/services/leads";
import { MetricTiles } from "./_components/MetricTiles";
import { FilterChips } from "./_components/FilterChips";
import { MeusLeadsToggle } from "./_components/MeusLeadsToggle";
import { SearchBox } from "./_components/SearchBox";
import { LeadRow } from "./_components/LeadRow";
import { buildHref, first, type SearchParamsRecord } from "./_components/query";
import styles from "./leads.module.css";

/**
 * `/leads` — the broker's morning queue (US1, FR-018 to FR-025).
 *
 * A Server Component reading `searchParams` (Next 16 makes it a Promise): the
 * filter, the search term, the "Meus leads" toggle, the page and the open
 * panel all live in the URL, never in component state, so a reload or the
 * back button always lands on the same view (FR-020, FR-023).
 */

export const dynamic = "force-dynamic";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsRecord>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const params = await searchParams;
  const scope = scopeForUser(session);

  const filterRaw = first(params.filtro) ?? "todos";
  const filter: LeadFilter = isLeadFilter(filterRaw) ? filterRaw : "todos";
  const search = first(params.q)?.trim() || undefined;
  const mineRaw = first(params.mine);
  const mine = mineRaw === undefined ? scope.defaultOwnLeadsOnly : mineRaw === "1";
  const page = Math.max(1, Number(first(params.page)) || 1);

  const [metrics, list] = await Promise.all([
    getFunnelMetrics(scope),
    listLeads(scope, { filter, mine, userId: session.userId, search, page }),
  ]);

  const totalPages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const hasPrev = list.page > 1;
  const hasNext = list.page < totalPages;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Leads</h1>
        <MetricTiles metrics={metrics} />
      </header>

      <div className={styles.controls}>
        <FilterChips current={filter} params={params} />
        <MeusLeadsToggle mine={mine} params={params} />
        <SearchBox defaultValue={search ?? ""} />
      </div>

      <div id="leads-list-region">
        {metrics.totalLeads === 0 ? (
          <div className={styles.emptyState}>
            <p>Nenhum lead por aqui ainda.</p>
            <p>Assim que alguém conversar com o agente pelo site, o lead aparece nesta lista.</p>
          </div>
        ) : list.rows.length === 0 ? (
          <div className={styles.emptyState}>
            <p>Nenhum lead encontrado.</p>
            <p>
              {search
                ? `Nada corresponde a "${search}". Tente outro termo ou remova o filtro.`
                : "Tente outro filtro ou volte para \"Todos\"."}
            </p>
          </div>
        ) : (
          <ul className={styles.list}>
            {list.rows.map((row) => (
              <LeadRow key={row.id} row={row} params={params} />
            ))}
          </ul>
        )}

        {list.total > 0 && totalPages > 1 && (
          <nav className={styles.pagination} aria-label="Paginação de leads">
            {hasPrev ? (
              <Link
                className={styles.pageLink}
                href={buildHref("/leads", params, { page: String(list.page - 1) })}
              >
                Anterior
              </Link>
            ) : (
              <span className={styles.pageLinkDisabled}>Anterior</span>
            )}
            <span className={styles.pageStatus}>
              Página {list.page} de {totalPages}
            </span>
            {hasNext ? (
              <Link
                className={styles.pageLink}
                href={buildHref("/leads", params, { page: String(list.page + 1) })}
              >
                Próxima
              </Link>
            ) : (
              <span className={styles.pageLinkDisabled}>Próxima</span>
            )}
          </nav>
        )}
      </div>
    </div>
  );
}
