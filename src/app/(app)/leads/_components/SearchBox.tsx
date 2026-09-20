"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import styles from "../leads.module.css";

const DEBOUNCE_MS = 300;

/**
 * FR-020: free-text search over name, phone, e-mail and preview line, kept in
 * `q`. The one client component of the list controls, debounced so every
 * keystroke does not push a new URL — but still a URL, never local state,
 * once it settles.
 */
export function SearchBox({ defaultValue }: { defaultValue: string }) {
  const [value, setValue] = useState(defaultValue);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setValue(defaultValue);
  }, [defaultValue]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function handleChange(next: string): void {
    setValue(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const search = new URLSearchParams(searchParams.toString());
      const trimmed = next.trim();
      if (trimmed) search.set("q", trimmed);
      else search.delete("q");
      search.delete("page");
      const qs = search.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    }, DEBOUNCE_MS);
  }

  return (
    <label className={styles.searchBox}>
      <span className={styles.srOnly}>Buscar leads</span>
      <input
        type="search"
        className={styles.searchInput}
        placeholder="Buscar por nome, telefone, e-mail ou prévia"
        value={value}
        onChange={(event) => handleChange(event.target.value)}
      />
    </label>
  );
}
