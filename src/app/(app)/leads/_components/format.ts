/**
 * The formatting rules shared by the queue and the panel. No date library
 * (plan.md "Not built") — `Intl.RelativeTimeFormat('pt-BR')` covers relative
 * times, and `Intl.NumberFormat` covers currency.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function relativeTime(date: Date, now: Date = new Date()): string {
  const diffMs = date.getTime() - now.getTime();
  const abs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });

  if (abs < MINUTE_MS) return rtf.format(Math.round(diffMs / 1000), "second");
  if (abs < HOUR_MS) return rtf.format(Math.round(diffMs / MINUTE_MS), "minute");
  if (abs < DAY_MS) return rtf.format(Math.round(diffMs / HOUR_MS), "hour");
  return rtf.format(Math.round(diffMs / DAY_MS), "day");
}

/** Absolute pt-BR date+time, used as the `title` beside a relative label. */
export function absoluteTime(date: Date): string {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

/** FR-018's median: seconds are meaningless to a broker, minutes and hours are. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(value);
}
