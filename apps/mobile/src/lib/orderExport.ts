// [ORDER-EXPORT · owner 11 Nov 2026] The phone's "Export orders" (Insights): a preset range of Guyana days, one
// store or all branches, fetched as CSV text from GET /vendor/orders/export and handed to the share sheet (React
// Native's own Share: no new native module, so it ships over the air). The server checks the role, the branches
// and the range (at most 366 days) again.

export type OrderExportRange = 'this-month' | 'last-month' | '30d' | '365d';

export const ORDER_EXPORT_RANGES: ReadonlyArray<{ key: OrderExportRange; label: string }> = [
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: '30d', label: '30 days' },
  { key: '365d', label: '12 months' },
];

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guyana', year: 'numeric', month: '2-digit', day: '2-digit' });

/** `YYYY-MM-DD` of an instant on the Guyana clock. */
export function guyanaDay(at: Date): string {
  return dayFmt.format(at);
}

/** Shift a `YYYY-MM-DD` by whole days (calendar arithmetic, no clock involved). */
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The first and last Guyana day of a preset, ending today (both days included). */
export function orderExportDays(range: OrderExportRange, now = new Date()): { from: string; to: string } {
  const today = guyanaDay(now);
  const monthStart = `${today.slice(0, 8)}01`;
  switch (range) {
    case 'this-month':
      return { from: monthStart, to: today };
    case 'last-month':
      return { from: `${addDays(monthStart, -1).slice(0, 8)}01`, to: addDays(monthStart, -1) };
    case '30d':
      return { from: addDays(today, -29), to: today };
    case '365d':
      return { from: addDays(today, -364), to: today };
  }
}

/** The share sheet's title: what the file holds. */
export function orderExportTitle(days: { from: string; to: string }, allBranches: boolean): string {
  return `Swift orders ${allBranches ? '(all branches) ' : ''}${days.from} to ${days.to}`;
}

/** The server's words when it refuses an export: the body was read as text, so the JSON error is parsed here. */
export function orderExportRefusal(err: unknown): string | null {
  const raw = (err as { response?: { data?: unknown } } | null)?.response?.data;
  if (typeof raw !== 'string') return null;
  try {
    const message = (JSON.parse(raw) as { error?: { message?: unknown } })?.error?.message;
    return typeof message === 'string' && message.trim() ? message.trim() : null;
  } catch {
    return null;
  }
}

/**
 * [REVIEW-2485-B S2-2 · REVIEW-2485-A S4-2] The share sheet carries the CSV as text; Android sends it through a
 * ~1 MB Binder transaction as UTF-16 (2 bytes a character), and chat apps cut long messages. Above this many
 * characters the phone does not try (sharing a real file needs a native module: a later store build); it says to
 * use the website or a shorter range instead.
 */
export const ORDER_EXPORT_PHONE_MAX_CHARS = 200_000;
export const ORDER_EXPORT_TOO_LARGE = 'Too large to share from the phone. Use the website (Insights, Export orders) or choose a shorter range.';

export function orderExportShareable(csv: string): boolean {
  return csv.length <= ORDER_EXPORT_PHONE_MAX_CHARS;
}

/** What "all" covers for this login (GET /vendor/orders/export/branches `scope`). */
export function orderExportAllLabel(scope: 'owner' | 'manager' | undefined): string {
  return scope === 'manager' ? 'All branches you manage' : 'All branches';
}
