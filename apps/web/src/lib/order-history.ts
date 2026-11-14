'use client';

import { apiFetch } from './auth';
import { normalizeVendorOrder, type VendorOrder } from './vendor-api';

// ---------------------------------------------------------------------------
// [WEB-HISTORY · owner rule: the website copies the app] The store's Order history, as the phone's
// VendorOrderHistoryScreen: search by order number or customer, the status buttons, and "Load more"
// pages of 20 (hooks/vendorops.ts useVendorOrderHistory). The same server read the app makes
// (GET /vendor/orders, newest first), so orders older than the board's newest 50 can be reached.
// The website also offers a range of days: the server already takes `from` and `to` (placedAt).
// ---------------------------------------------------------------------------

/** The phone's status buttons, in its order and with its words. */
export const HISTORY_FILTERS: ReadonlyArray<{ label: string; status?: string }> = [
  { label: 'All' },
  { label: 'Delivered', status: 'DELIVERED' },
  { label: 'Completed', status: 'COMPLETED' },
  { label: 'Cancelled', status: 'CANCELLED' },
];

/** The phone's page size (useVendorOrderHistory asks for 20 at a time). */
export const HISTORY_PAGE_SIZE = 20;

/** Guyana keeps UTC-4 all year (no daylight saving), as the server's day helpers do. */
const GUYANA_OFFSET = '-04:00';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The first instant of a Guyana day (`YYYY-MM-DD`), as the server reads `from`. */
export function guyanaDayStart(day: string): string {
  return `${day}T00:00:00.000${GUYANA_OFFSET}`;
}

/** The last instant of a Guyana day, so `to` takes in the whole of that day. */
export function guyanaDayEnd(day: string): string {
  return `${day}T23:59:59.999${GUYANA_OFFSET}`;
}

export type OrderHistoryFilters = { status?: string; search?: string; from?: string; to?: string };

/** Why a chosen range of days cannot be asked for, or null when it can (either end may be left open). */
export function historyRangeProblem(from: string, to: string): string | null {
  if ((from && !DAY.test(from)) || (to && !DAY.test(to))) return 'Choose a whole day.';
  if (from && to && from > to) return 'Choose a start day on or before the end day.';
  return null;
}

export type OrderHistoryPage = { orders: VendorOrder[]; page: number; total: number; hasNext: boolean };

const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

/** One page of the history. `meta` is the server's paginator (page, total, hasNext). */
export async function getOrderHistory(filters: OrderHistoryFilters, page: number): Promise<OrderHistoryPage> {
  const q = new URLSearchParams();
  if (filters.status) q.set('status', filters.status);
  if (filters.search) q.set('search', filters.search);
  if (filters.from) q.set('from', guyanaDayStart(filters.from));
  if (filters.to) q.set('to', guyanaDayEnd(filters.to));
  q.set('page', String(page));
  q.set('limit', String(HISTORY_PAGE_SIZE));
  const r = await apiFetch(`/api/v1/vendor/orders?${q}`);
  const rows: unknown[] = Array.isArray(r.data) ? r.data : [];
  const meta = (r.meta ?? {}) as { page?: unknown; total?: unknown; hasNext?: unknown };
  const orders = rows.map(normalizeVendorOrder);
  const total = count(meta.total) ?? orders.length;
  const served = count(meta.page) ?? page;
  // An older server without `hasNext`: more remain while fewer than the total have been served.
  const hasNext = typeof meta.hasNext === 'boolean' ? meta.hasNext : (served - 1) * HISTORY_PAGE_SIZE + orders.length < total;
  return { orders, page: served, total, hasNext };
}
