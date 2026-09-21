/**
 * All list state lives in the query string (FR-020, FR-023): filter, search,
 * the "Meus leads" toggle, the page and the open panel. Every server-rendered
 * control here is a plain `<Link>` built by this helper, never a form post or
 * client-side state — a reload or the back button always lands on the same
 * screen.
 */

export type SearchParamsRecord = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Starts from the current query string, applies `overrides` (a `key: undefined`
 * removes it — used to reset `page` on every filter/search/toggle change, and
 * to drop `lead` when the panel closes), and returns a relative href.
 */
export function buildHref(
  base: string,
  params: SearchParamsRecord,
  overrides: Record<string, string | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const v = first(value);
    if (v !== undefined && v !== "") search.set(key, v);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) search.delete(key);
    else search.set(key, value);
  }
  const qs = search.toString();
  return qs.length > 0 ? `${base}?${qs}` : base;
}

export { first };
