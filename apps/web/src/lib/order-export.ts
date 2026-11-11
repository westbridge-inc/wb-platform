'use client';

import { BROWSER_API_ORIGIN as API_URL } from './browser-api-origin';
import { BROWSER_CLIENT, apiFetch, getSelectedStore } from './auth';

// [ORDER-EXPORT · owner 11 Nov 2026] "Export orders": the order history for a range of Guyana days as a CSV file
// (GET /vendor/orders/export; owners and managers; finance columns only, no customer details). `branch` is one
// store's id or 'all' (every branch this login may see sales for). The answer is a CSV, so it is read here rather
// than through apiFetch, and saved under the name the server gives it.

/** [REVIEW-2485-B S4-7] The branches this login may export (owner: every branch; a manager: the stores they manage). */
export type ExportBranches = { scope: 'owner' | 'manager'; branches: Array<{ id: string; name: string; city: string | null }> };
export const getExportBranches = () => apiFetch('/api/v1/vendor/orders/export/branches').then((r) => r.data as ExportBranches);

/** `YYYY-MM-DD` of today on the Guyana clock (the server's days are Guyana days). */
export function guyanaToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guyana', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The first day of this Guyana month. */
export function guyanaMonthStart(now = new Date()): string {
  return `${guyanaToday(now).slice(0, 8)}01`;
}

export async function downloadOrdersCsv(storeId: string, input: { from: string; to: string; branch: string }): Promise<void> {
  if (getSelectedStore() !== storeId) throw new Error('The selected store changed. Try again.');
  const q = new URLSearchParams({ from: input.from, to: input.to, branch: input.branch });
  const res = await fetch(`${API_URL}/api/v1/vendor/orders/export?${q.toString()}`, {
    credentials: 'include',
    headers: { 'X-Swift-Client': BROWSER_CLIENT, 'x-client-platform': 'web', 'x-vendor-id': storeId },
  });
  if (!res.ok) {
    const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(json?.error?.message || 'Couldn’t export the orders. Try again.');
  }
  const named = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1];
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = named ?? `swift-orders-${input.from}-to-${input.to}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
