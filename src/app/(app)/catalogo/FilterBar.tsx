"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback, useTransition } from "react";
import styles from "./catalogo.module.css";

/** modelo-de-dados.md §5's seeded zones — filter-only, not a validation rule. */
const NEIGHBORHOODS = [
  "Moema",
  "Vila Mariana",
  "Brooklin",
  "Campo Belo",
  "Saúde",
  "Pinheiros",
  "Vila Madalena",
  "Perdizes",
  "Butantã",
  "Centro",
  "Santana",
];
const REGIONS = ["zona sul", "zona oeste", "centro", "zona norte"];

/**
 * Client component so `code` filters as the broker types — no debounce
 * beyond the input's own change event (constitution X: this is the primary,
 * instant lookup; everything else here is secondary browsing, laid out with
 * less weight).
 */
export function FilterBar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const update = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) params.set(key, value);
      else params.delete(key);
      params.delete("page"); // any filter change restarts pagination
      startTransition(() => {
        router.push(`${pathname}?${params.toString()}`, { scroll: false });
      });
    },
    [pathname, router, searchParams],
  );

  const clear = useCallback(() => {
    startTransition(() => {
      router.push(pathname, { scroll: false });
    });
  }, [pathname, router]);

  const hasFilters = searchParams.toString().length > 0;

  return (
    <form className={styles.filterBar} onSubmit={(e) => e.preventDefault()} role="search" aria-label="Filtrar catálogo">
      <div className={`${styles.field} ${styles.codeField}`}>
        <label htmlFor="filter-code">Código</label>
        <input
          id="filter-code"
          type="text"
          placeholder="ex. MOE-0042"
          defaultValue={searchParams.get("code") ?? ""}
          onChange={(e) => update("code", e.target.value.trim().toUpperCase())}
          autoComplete="off"
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="filter-transaction">Transação</label>
        <select
          id="filter-transaction"
          defaultValue={searchParams.get("transaction") ?? ""}
          onChange={(e) => update("transaction", e.target.value)}
        >
          <option value="">Todas</option>
          <option value="sale">Venda</option>
          <option value="rent">Aluguel</option>
        </select>
      </div>

      <div className={styles.field}>
        <label htmlFor="filter-neighborhood">Bairro</label>
        <select
          id="filter-neighborhood"
          defaultValue={searchParams.get("neighborhood") ?? ""}
          onChange={(e) => update("neighborhood", e.target.value)}
        >
          <option value="">Todos</option>
          {NEIGHBORHOODS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label htmlFor="filter-region">Região</label>
        <select
          id="filter-region"
          defaultValue={searchParams.get("region") ?? ""}
          onChange={(e) => update("region", e.target.value)}
        >
          <option value="">Todas</option>
          {REGIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label htmlFor="filter-max-price">Preço até</label>
        <input
          id="filter-max-price"
          type="number"
          min={0}
          step={1000}
          placeholder="sem limite"
          defaultValue={searchParams.get("maxPrice") ?? ""}
          onChange={(e) => update("maxPrice", e.target.value)}
        />
      </div>

      <div className={styles.field}>
        <label htmlFor="filter-min-bedrooms">Quartos (mín.)</label>
        <input
          id="filter-min-bedrooms"
          type="number"
          min={0}
          placeholder="qualquer"
          defaultValue={searchParams.get("minBedrooms") ?? ""}
          onChange={(e) => update("minBedrooms", e.target.value)}
        />
      </div>

      {hasFilters && (
        <button type="button" className={styles.clearButton} onClick={clear}>
          Limpar filtros
        </button>
      )}
    </form>
  );
}
