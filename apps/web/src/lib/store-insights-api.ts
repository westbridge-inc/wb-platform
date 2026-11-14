'use client';

import { BROWSER_API_ORIGIN as API_URL } from './browser-api-origin';
import { BROWSER_CLIENT, apiFetch, getSelectedStore } from './auth';

// ---------------------------------------------------------------------------
// [WEB-INSIGHTS · owner rule: the website copies the app] The reads behind the phone's Insights screen
// (apps/mobile/src/services/api.ts vendorApi: analyticsPopularItems, analyticsBusyHours,
// analyticsRepeatCustomers, standing, itemFeedback, reviews, respondReview, salesStatement) and the
// QR counter card the server already prints (GET /vendor/qr/assets/pdf). Same routes, same parameters.
// ---------------------------------------------------------------------------

const V = '/api/v1/vendor';

/** GET /vendor/analytics/popular-items: the store's items by lifetime orders, each with its 30-day quantity. */
export type PopularItem = {
  id: string; name: string; imageUrl?: string | null; totalOrdered?: unknown; recentOrders?: unknown;
  category?: { id: string; name: string } | null;
};
export const getPopularItems = (limit = 8) =>
  apiFetch(`${V}/analytics/popular-items?limit=${limit}`).then((r) => (Array.isArray(r.data) ? r.data : []) as PopularItem[]);

/** GET /vendor/analytics/busy-hours: orders by Guyana hour over the last 30 days. */
export type BusyHours = { hours: Array<{ hour: number; orders: number }>; peak?: { hour: number; orders: number } | null; total?: number };
export const getBusyHours = () =>
  apiFetch(`${V}/analytics/busy-hours`).then((r) => {
    const data = r.data as unknown;
    // The phone reads both shapes (a bare list, or { hours }); so does this.
    if (Array.isArray(data)) return { hours: data } as BusyHours;
    return (data ?? { hours: [] }) as BusyHours;
  });

/** GET /vendor/analytics/repeat-customers: customers with two or more finished orders here. */
export type RepeatCustomers = { totalCustomers?: number; repeatCustomers?: number; repeatRate?: number; totalOrders?: number };
export const getRepeatCustomers = () => apiFetch(`${V}/analytics/repeat-customers`).then((r) => (r.data ?? {}) as RepeatCustomers);

/** GET /vendor/standing: the phone's StandingCard data (daily-folded on the server). */
export interface StandingData {
  standing: string;
  displayRating: number | null;
  ratingBucket: string;
  ratingCount: number;
  topRated: boolean;
  trend: Array<{ weekStart: string; average: number | null; count: number }>;
  topPositive: Array<{ tag: string; label: string; count: number }>;
  topNegative: Array<{ tag: string; label: string; count: number }>;
  coaching: Array<{ tag: string; label: string; line: string }>;
  groupSize?: number;
}
export const getStanding = () => apiFetch(`${V}/standing`).then((r) => r.data as StandingData);

/** GET /vendor/analytics/item-feedback: thumbs up and down per item, last 30 days, worst first. */
export type ItemFeedback = { itemId: string; name: string; up: number; down: number };
export const getItemFeedback = () =>
  apiFetch(`${V}/analytics/item-feedback`).then((r) => (Array.isArray(r.data) ? r.data : []) as ItemFeedback[]);

/** GET /vendor/reviews: what customers said (never who), newest first, with the store's own reply. */
export type StoreReview = {
  id: string; score: number; comment: string | null; response: string | null; respondedAt?: string | null; createdAt: string;
};
/** The server's summary also carries its mean; the website draws the mean from these counts (RatingsCard). */
export type ReviewsSummary = { totalReviews: number; distribution: Record<string, number> };
export const getStoreReviews = () =>
  apiFetch(`${V}/reviews`).then((r) => ({
    reviews: (Array.isArray(r.data) ? r.data : []) as StoreReview[],
    summary: (r.summary ?? null) as ReviewsSummary | null,
  }));

/** POST /vendor/reviews/:id/respond: the store's public reply (one per review, editable; at most 1000 characters). */
export const REVIEW_REPLY_MAX = 1000;
export const respondToReview = (id: string, response: string) =>
  apiFetch(`${V}/reviews/${encodeURIComponent(id)}/respond`, { method: 'POST', body: JSON.stringify({ response }) });

/** GET /vendor/sales-statement?link=1: the 30-day statement as a short-lived signed path that opens without the
 *  session (the same link the phone's in-app browser opens). */
export const getSalesStatementPath = () =>
  apiFetch(`${V}/sales-statement?link=1`).then((r) => {
    const path = (r.data as { path?: unknown } | null | undefined)?.path;
    // A path on Swift's API only: '//host' would be protocol-relative.
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new Error('Statement link missing from the response.');
    return path;
  });

/**
 * [WEB-QR · audit C8] "Print counter card": the server's print-ready card (GET /vendor/qr/assets/pdf?template=card,
 * owners and managers, 20 an hour) saved under the name the server gives it. The answer is a PDF, so it is read
 * here rather than through apiFetch, with the selected store named as every dashboard read names it.
 */
export async function downloadQrCounterCard(storeId: string): Promise<void> {
  if (getSelectedStore() !== storeId) throw new Error('The selected store changed. Try again.');
  const download = () => fetch(`${API_URL}${V}/qr/assets/pdf?template=card`, {
    credentials: 'include',
    headers: { 'X-Swift-Client': BROWSER_CLIENT, 'x-client-platform': 'web', 'x-vendor-id': storeId },
  });
  let res = await download();
  if (res.status === 401) {
    // [REVIEW-2517 S4-3] An expired sign-in renews itself as on every other read: the store's code read goes through
    // apiFetch, which renews the session (or signs out and says so), then the card is asked for once more.
    await apiFetch(`${V}/qr`, undefined, { storeId });
    if (getSelectedStore() !== storeId) throw new Error('The selected store changed. Try again.');
    res = await download();
  }
  if (!res.ok) {
    if (res.status === 429) throw new Error('You have downloaded the card many times this hour. Try again later.');
    const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(json?.error?.message || 'Couldn’t download the card. Try again.');
  }
  const named = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1];
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = named ?? 'swift-qr-card.pdf';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
