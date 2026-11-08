import { useCallback, useEffect, useRef } from 'react';
import { onlineManager, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import {
  favoritesRead,
  liveOrdersRead,
  marketItemsRead,
  ordersHistoryRead,
  prefetchActiveRide,
  searchRead,
  vendorsRead,
} from './customer';
import { rideCapabilitiesRead } from './rides';
import { serviceCatalogRead } from '../modules/services/useServiceCatalog';
import { searchBrowseParams } from '../lib/searchBrowse';
import { usePressRead, type PressReadHandlers } from './pressRead';

// ---------------------------------------------------------------------------
// [APP-SPEED D · owner 7 Nov: "customer side, everything — you tap the Services
// tab or Taxi or Groceries — it LOADS, then goes to it"]
//
// Each door on Home (the service tiles, the Market tab) opened on a spinner
// while its first list came from Atlanta (~0.3 s a round trip from Guyana,
// often two or three). This asks those first reads AHEAD of the tap, from the
// server, into the very keys the screens open on (the shared *Read builders in
// hooks/customer, hooks/rides, services/useServiceCatalog, lib/searchBrowse):
//
//   - when Home has drawn a fresh feed and Swift has been quiet a moment
//     (HomeScreen), ONE door at a time, in the order the tiles sit, stopping
//     the moment Home is covered, Swift goes to the background or the phone
//     goes offline; at most once per Home feed read, and a door read in the
//     last DOOR_FRESH_MS (or on its way) is not asked again;
//   - at the finger-down on a tile (pressRead: after it rests 180 ms, never
//     on a scroll), the same reads.
//
// What a read ahead puts in memory is the server's own answer: the screen draws
// it at once and still re-reads behind it on open (these families stay at zero
// freshness, lib/appQueryPolicy), so a price, an order or a ride is never shown
// as final from here. Nothing here books, orders or pays; the Taxi screen still
// holds Request until its own "is a ride in progress?" lands (#2392).
//
// Bounded: only first pages (a list the person scrolled is never cut back to
// one page), no retries (a failed read ahead costs one request and the screen
// asks again itself), and only the doors a signed-in person can open (Orders,
// Favourites, Taxi) are asked for one.
// ---------------------------------------------------------------------------

/** A door's read is asked again ahead of a tap only when it is older than this. */
export const DOOR_FRESH_MS = 120_000;

/** The doors Home reads ahead, in the order its tiles (then the Market tab) sit. */
export const HOME_DOORS = ['taxi', 'food', 'groceries', 'services', 'orders', 'favourites', 'market'] as const;
export type HomeDoor = (typeof HOME_DOORS)[number];

export interface DoorContext {
  signedIn: boolean;
  /** The customer's GRANTED place (lib/deviceLocation grantedLocationFix), or null. */
  here: { latitude: number; longitude: number } | null;
  /** The server has confirmed the Market tab (lib/homeReliability marketTabVisible). */
  marketVisible: boolean;
}

/** Whether a door's plain read should be asked now: nothing (or a failure) in memory, a read waiting on its own
 *  re-read, or an answer older than DOOR_FRESH_MS. Never while the same read is on its way. */
export function doorReadDue(qc: QueryClient, queryKey: QueryKey, now = Date.now()): boolean {
  const state = qc.getQueryState(queryKey);
  if (!state) return true;
  if (state.fetchStatus !== 'idle') return false;
  if (state.data === undefined) return true;
  return state.isInvalidated || now - state.dataUpdatedAt > DOOR_FRESH_MS;
}

/** A list read page by page is asked ahead only when nothing is in memory: a fresh read here would cut the pages
 *  the person scrolled back to one, and the screen re-reads its own pages on open. */
function firstPageDue(qc: QueryClient, queryKey: QueryKey): boolean {
  const state = qc.getQueryState(queryKey);
  return !state || (state.fetchStatus === 'idle' && state.data === undefined);
}

function plain(qc: QueryClient, read: { queryKey: QueryKey; queryFn: () => Promise<unknown> }): Promise<void> | undefined {
  if (!doorReadDue(qc, read.queryKey)) return undefined;
  return qc.prefetchQuery({ queryKey: read.queryKey, queryFn: read.queryFn, retry: false });
}

function pages<P>(qc: QueryClient, read: { queryKey: QueryKey; initialPageParam: P; queryFn: (ctx: { pageParam: P }) => Promise<unknown>; getNextPageParam: (last: any) => P | undefined }): Promise<void> | undefined {
  if (!firstPageDue(qc, read.queryKey)) return undefined;
  return qc.prefetchInfiniteQuery({
    queryKey: read.queryKey,
    initialPageParam: read.initialPageParam,
    queryFn: ({ pageParam }) => read.queryFn({ pageParam: pageParam as P }),
    getNextPageParam: read.getNextPageParam,
    retry: false,
  });
}

const settleAll = (asked: Array<Promise<void> | undefined>): Promise<void> | undefined => {
  const live = asked.filter((p): p is Promise<void> => p !== undefined);
  return live.length ? Promise.all(live).then(() => undefined) : undefined;
};

/** The store list Search opens on from a Food or Groceries tile (SearchScreen: no words, the tile's type, the
 *  granted place). */
export function doorStoreListKey(type: 'RESTAURANT' | 'SUPERMARKET', here: DoorContext['here']) {
  return vendorsRead(searchBrowseParams({ type, latitude: here?.latitude, longitude: here?.longitude }));
}

/**
 * Ask a door's first reads, or nothing when there is nothing to ask (fresh, on its way, a door this person cannot
 * open, offline). Resolves when every read it asked has settled; a failed read resolves too (the screen says so).
 */
export function readDoor(qc: QueryClient, door: HomeDoor, ctx: DoorContext): Promise<void> | undefined {
  if (!onlineManager.isOnline()) return undefined;
  switch (door) {
    case 'food':
      return plain(qc, doorStoreListKey('RESTAURANT', ctx.here));
    case 'groceries':
      return plain(qc, doorStoreListKey('SUPERMARKET', ctx.here));
    case 'services':
      return plain(qc, serviceCatalogRead());
    case 'taxi':
      // The booking form is for a signed-in person (TaxiScreen); a guest's Taxi door asks nothing.
      return ctx.signedIn ? settleAll([prefetchActiveRide(qc), plain(qc, rideCapabilitiesRead())]) : undefined;
    case 'orders':
      return ctx.signedIn ? settleAll([plain(qc, liveOrdersRead()), pages(qc, ordersHistoryRead())]) : undefined;
    case 'favourites':
      return ctx.signedIn ? plain(qc, favoritesRead()) : undefined;
    case 'market':
      return ctx.marketVisible ? pages(qc, marketItemsRead()) : undefined;
    default:
      return undefined;
  }
}

/** A category tile's door (Home's "Find by category"): Search opens on the engine's answer for its name. */
export function readCategorySearch(qc: QueryClient, name: string, here: DoorContext['here']): Promise<void> | undefined {
  const q = name.trim();
  if (q.length < 2 || !onlineManager.isOnline()) return undefined;
  return plain(qc, searchRead(q, { type: undefined, lat: here?.latitude, lng: here?.longitude }));
}

/** A category rail chip's door (CategoryFeed): the category's store list, as that screen asks for it. */
export function readCategoryFeed(qc: QueryClient, slug: string, here: DoorContext['here']): Promise<void> | undefined {
  if (!slug || !onlineManager.isOnline()) return undefined;
  return plain(qc, vendorsRead({
    category: slug,
    ...(here ? { lat: String(here.latitude), lng: String(here.longitude) } : {}),
  }));
}

/**
 * Read `doors` one at a time, each after the last has settled, while `stillWanted()` holds and the phone is online.
 * Resolves when done or stopped.
 */
export async function readDoorsInTurn(qc: QueryClient, doors: readonly HomeDoor[], ctx: DoorContext, stillWanted: () => boolean): Promise<void> {
  for (const door of doors) {
    if (!stillWanted() || !onlineManager.isOnline()) return;
    await readDoor(qc, door, ctx)?.catch(() => undefined);
  }
}

/** How long Home's feed must have been on screen, with Swift quiet, before its doors are read ahead. */
export const HOME_DOORS_IDLE_MS = 1_500;

/**
 * Home's reads ahead: once per fresh feed (`feedAt` = the feed's dataUpdatedAt), after HOME_DOORS_IDLE_MS of quiet
 * (no read in flight), while `enabled` (Home in front, a feed of content). Stops when `enabled` drops.
 */
export function useHomeDoorReads(enabled: boolean, feedAt: number, ctx: DoorContext): void {
  const qc = useQueryClient();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const doneFor = useRef<number | null>(null);
  useEffect(() => {
    if (!enabled || doneFor.current === feedAt) return undefined;
    let wanted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A read still on its way (an ad, the category rail, a store's menu): wait for the next quiet moment.
    const fire = () => {
      timer = undefined;
      if (!wanted) return;
      if (qc.isFetching() > 0) { timer = setTimeout(fire, HOME_DOORS_IDLE_MS); return; }
      doneFor.current = feedAt;
      void readDoorsInTurn(qc, HOME_DOORS, ctxRef.current, () => wanted);
    };
    timer = setTimeout(fire, HOME_DOORS_IDLE_MS);
    return () => {
      wanted = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled, feedAt, qc]);
}

/** The press handlers for a Home tile's door (`{...doorPress('food')}`), or nothing to spread for a door with no
 *  read (Send, Scan). */
export function useDoorPress(ctx: DoorContext): (door: HomeDoor | null) => PressReadHandlers | Record<string, never> {
  const qc = useQueryClient();
  const pressRead = usePressRead();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  return useCallback(
    (door) => (door ? pressRead(() => readDoor(qc, door, ctxRef.current)) : {}),
    [qc, pressRead],
  );
}
