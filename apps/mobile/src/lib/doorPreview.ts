import type { Query, QueryClient } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [APP-SPEED A · owner 7 Nov: "tapping and lagginess"] A door opens on what the
// phone ALREADY HAS from the server, never on a guess.
//
// A tap on a store card used to open a blank spinner until the whole menu came
// back (~0.3 s per round trip from Guyana, more on a slow line); "Track order"
// did the same although the list it was tapped from held the order. These
// helpers hand the next screen the few facts the tapped card already showed
// (a store's name and photo; a dish's name and photo), or find the order in
// the lists already in memory. The screen draws them at once and says it is
// still checking; every action that changes money, status or the cart waits
// for the server's own answer.
// ---------------------------------------------------------------------------

/** What a store card showed: enough to draw the store's header while its menu loads. */
export interface StorePreview {
  name: string;
  coverImageUrl: string | null;
  logoUrl: string | null;
  /** [STORE-WORDS sweep] The store's kind when the card had it: the opening says "Loading the menu" only for a restaurant. */
  vendorType?: string;
}

/** What a dish card showed: enough to draw the dish's header while its store's menu loads. */
export interface ItemPreview {
  name: string;
  imageUrl: string | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

/** The store card's own facts (from the server's feed row), or nothing when it has no name. */
export function storePreviewOf(row: unknown): StorePreview | undefined {
  const r = (row ?? {}) as Record<string, unknown>;
  const name = text(r['name']);
  if (!name) return undefined;
  const vendorType = text(r['vendorType']);
  return { name, coverImageUrl: text(r['coverImageUrl']), logoUrl: text(r['logoUrl']), ...(vendorType ? { vendorType } : {}) };
}

/** The dish card's own facts (from the server's feed row), or nothing when it has no name. */
export function itemPreviewOf(row: unknown): ItemPreview | undefined {
  const r = (row ?? {}) as Record<string, unknown>;
  const name = text(r['name']);
  if (!name) return undefined;
  return { name, imageUrl: text(r['imageUrl']) };
}

/** A route's `preview` param, only when it has the shape a card writes (a deep link or an
 *  older caller passes none, and the screen keeps its plain loading state). */
export function readStorePreview(param: unknown): StorePreview | null {
  return param && typeof param === 'object' ? storePreviewOf(param) ?? null : null;
}

export function readItemPreview(param: unknown): ItemPreview | null {
  return param && typeof param === 'object' ? itemPreviewOf(param) ?? null : null;
}

// ── Orders and rides already in memory ─────────────────────────────────────

const rowsOf = (data: unknown): unknown[] => {
  if (!data || typeof data !== 'object') return [];
  const d = data as Record<string, unknown>;
  // Live orders ({ items }), the history pages ({ pages: [{ items }] }), a plain list, and Home ({ activeOrder }).
  if (Array.isArray(d['pages'])) return (d['pages'] as unknown[]).flatMap(rowsOf);
  if (Array.isArray(d['items'])) return d['items'] as unknown[];
  if (Array.isArray(data)) return data as unknown[];
  return d['activeOrder'] ? [d['activeOrder']] : [];
};

/**
 * The newest copy of order `id` in the order lists or Home's live-order card,
 * as the server last sent it — or undefined. Only a list that came back
 * successfully counts; a list that is waiting on its own re-read
 * (invalidated) is skipped, because its rows may describe a moment that has
 * passed.
 */
export function cachedOrderRow<T = Record<string, unknown>>(qc: QueryClient, id: string): T | undefined {
  if (!id) return undefined;
  let found: { row: T; at: number } | undefined;
  const consider = (query: Query) => {
    const { data, status, isInvalidated, dataUpdatedAt } = query.state;
    if (status !== 'success' || isInvalidated) return;
    for (const row of rowsOf(data)) {
      if ((row as { id?: unknown } | null)?.id === id && (!found || dataUpdatedAt > found.at)) found = { row: row as T, at: dataUpdatedAt };
    }
  };
  for (const query of qc.getQueryCache().findAll({ queryKey: ['customer', 'orders'] })) consider(query);
  for (const query of qc.getQueryCache().findAll({ queryKey: ['customer', 'home'] })) consider(query);
  return found?.row;
}

/** The newest cart quote already in memory (another screen asked for the same server cart with
 *  other choices or another place). Only a non-empty quote that came back successfully and is not
 *  waiting on its own re-read; never an empty cart (it would say "Your cart is empty" by guess). */
export function newestCachedCart<T = unknown>(qc: QueryClient): T | undefined {
  let best: { data: T; at: number } | undefined;
  for (const query of qc.getQueryCache().findAll({ queryKey: ['customer', 'cart'] })) {
    const { data, status, isInvalidated, dataUpdatedAt } = query.state;
    if (status !== 'success' || isInvalidated || data == null) continue;
    const items = (data as { items?: unknown }).items;
    if (!Array.isArray(items) || items.length === 0) continue;
    if (!best || dataUpdatedAt > best.at) best = { data: data as T, at: dataUpdatedAt };
  }
  return best?.data;
}
