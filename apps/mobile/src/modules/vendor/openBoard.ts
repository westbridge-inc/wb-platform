// ---------------------------------------------------------------------------
// [STORE-BOARD S1 · parity audit 14 Nov 2026, A1] The live board reads EVERY open order of the store
// (GET /vendor/orders/open), not the newest page of all orders. What the server did not send is said on the board,
// never dropped in silence. A server without the open read yet (404) gets the newest 50 instead, and the board says
// older open orders may be missing.
//
// A plain file with no imports: the website's board reads the same rules and words (imported as is).
// ---------------------------------------------------------------------------

export interface OpenBoardMeta {
  /** Open orders the server holds for this board. */
  total: number;
  /** Rows on the board. */
  shown: number;
  /** Open orders the server did not send (past its cap). */
  notShown: number;
  /** True when the board fell back to the newest page and there were more orders than it holds. */
  partial: boolean;
}

/** The newest page an older server answers instead (its own cap). */
export const FALLBACK_PAGE = 50;

type Answer = { data?: { data?: unknown; meta?: unknown } };
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** What the open read says about itself (rows on the board, and how many the server left out). */
export function openMetaOf(rawMeta: unknown, shown: number): OpenBoardMeta {
  const m = (rawMeta ?? {}) as Record<string, unknown>;
  const total = num(m['total']) ?? shown;
  return { total, shown, notShown: num(m['notShown']) ?? Math.max(0, total - shown), partial: false };
}

/** An older server's newest page instead: partial when it holds more orders than the page (or will not say). */
export function fallbackMetaOf(rawMeta: unknown, shown: number): OpenBoardMeta {
  const total = num(((rawMeta ?? {}) as Record<string, unknown>)['total']);
  return { total: total ?? shown, shown, notShown: 0, partial: total == null || total > shown };
}

/** A server without the open read answers 404 (the route did not exist). */
export function missingOpenRead(error: unknown): boolean {
  const e = error as { response?: { status?: number }; status?: number } | null;
  return (e?.response?.status ?? e?.status) === 404;
}

/** One board read on the phone: every open order, or (older server) the newest page. Throws anything but a
 *  missing route. */
export async function readOpenBoard(api: {
  openOrders: () => Promise<Answer>;
  orders: (params: { limit: number }) => Promise<Answer>;
}): Promise<{ orders: any[]; meta: OpenBoardMeta }> {
  try {
    const r = await api.openOrders();
    const orders = Array.isArray(r?.data?.data) ? (r.data!.data as any[]) : [];
    return { orders, meta: openMetaOf(r?.data?.meta, orders.length) };
  } catch (e) {
    if (!missingOpenRead(e)) throw e;
  }
  const r = await api.orders({ limit: FALLBACK_PAGE });
  const orders = Array.isArray(r?.data?.data) ? (r.data!.data as any[]) : [];
  return { orders, meta: fallbackMetaOf(r?.data?.meta, orders.length) };
}

/** The board's honest note, or null when every open order is on it. */
export function openBoardNote(meta: OpenBoardMeta | null): string | null {
  if (!meta) return null;
  if (meta.notShown > 0) {
    return `${meta.notShown} more open ${meta.notShown === 1 ? 'order is' : 'orders are'} not shown (${meta.shown} of ${meta.total} shown).`;
  }
  if (meta.partial) return `Showing the newest ${meta.shown} orders — older open orders may not be shown.`;
  return null;
}
