import Link from "next/link";
import { getDefaultAgencyId, listProperties, type PropertyFilters } from "@/services/properties";
import { PropertyCard } from "./PropertyCard";
import { FilterBar } from "./FilterBar";
import styles from "./catalogo.module.css";

export const dynamic = "force-dynamic";

/**
 * `/catalogo` — a broker mid-conversation with a lead (or checking the
 * agent's own suggestion) confirming a property is real. No session guard
 * here (FR-017; spec 003 wraps `(app)/*` later).
 */

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function toFilters(params: SearchParams): PropertyFilters {
  const code = first(params.code)?.trim();
  const transaction = first(params.transaction);
  const neighborhood = first(params.neighborhood)?.trim();
  const region = first(params.region)?.trim();
  const maxPriceRaw = first(params.maxPrice);
  const minBedroomsRaw = first(params.minBedrooms);

  const filters: PropertyFilters = {};
  if (code) filters.code = code;
  if (transaction === "sale" || transaction === "rent") filters.transaction = transaction;
  if (neighborhood) filters.neighborhood = neighborhood;
  if (region) filters.region = region;
  const maxPrice = maxPriceRaw ? Number(maxPriceRaw) : undefined;
  if (maxPrice !== undefined && Number.isFinite(maxPrice) && maxPrice > 0) filters.maxPrice = maxPrice;
  const minBedrooms = minBedroomsRaw ? Number(minBedroomsRaw) : undefined;
  if (minBedrooms !== undefined && Number.isFinite(minBedrooms) && minBedrooms >= 0) filters.minBedrooms = minBedrooms;

  return filters;
}

function pageHref(params: SearchParams, page: number): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const v = first(value);
    if (v) search.set(key, v);
  }
  search.set("page", String(page));
  return `/catalogo?${search.toString()}`;
}

export default async function CatalogoPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = toFilters(params);
  const requestedPage = Number(first(params.page)) || 1;

  const agencyId = await getDefaultAgencyId();
  const result = agencyId
    ? await listProperties(agencyId, filters, requestedPage)
    : { items: [], total: 0, page: 1, pageSize: 24 as const };

  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const hasPrev = result.page > 1;
  const hasNext = result.page < totalPages;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Catálogo de imóveis</h1>
        <p className={styles.subtitle}>
          Inventário ativo da Imobiliária Demo — confirme o código de um imóvel sugerido pelo agente ou explore por
          filtro.
        </p>
      </header>

      <div className={styles.content}>
        <FilterBar />

        <p className={styles.resultSummary}>
          {result.total === 0
            ? "Nenhum imóvel encontrado."
            : `${result.total} imóve${result.total === 1 ? "l" : "is"} encontrado${result.total === 1 ? "" : "s"}.`}
        </p>

        {result.items.length === 0 ? (
          <div className={styles.emptyState}>
            <p>Nenhum imóvel corresponde a esses filtros.</p>
            <p>Tente ampliar a faixa de preço ou remover um dos filtros ativos.</p>
          </div>
        ) : (
          <div className={styles.grid}>
            {result.items.map((property) => (
              <PropertyCard key={property.id} property={property} />
            ))}
          </div>
        )}

        {result.total > 0 && (
          <nav className={styles.pagination} aria-label="Paginação do catálogo">
            {hasPrev ? (
              <Link className={styles.pageLink} href={pageHref(params, result.page - 1)}>
                Anterior
              </Link>
            ) : (
              <span className={styles.pageLinkDisabled}>Anterior</span>
            )}
            <span className={styles.pageStatus}>
              Página {result.page} de {totalPages}
            </span>
            {hasNext ? (
              <Link className={styles.pageLink} href={pageHref(params, result.page + 1)}>
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
