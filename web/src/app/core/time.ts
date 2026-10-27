const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const DATE = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** "just now", "12 min ago" or "3 h ago" within a day; the date and time after that. */
export function since(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `on ${DATE_TIME.format(new Date(iso))}`;
}

/** The exact date and time, for a tooltip. */
export function dateTime(iso: string): string {
  return DATE_TIME.format(new Date(iso));
}

/** A YYYY-MM-DD day as "27 Oct 2026". */
export function day(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return DATE.format(new Date(y, m - 1, d));
}

/** The last `n` days as YYYY-MM-DD, oldest first, today last. */
export function lastDays(n: number, now = new Date()): string[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1 - i));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
}
