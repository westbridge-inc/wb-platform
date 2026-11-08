import { useCallback, useEffect, useRef } from 'react';
import { hashKey, onlineManager, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
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
import { retryRead } from '../lib/appQueryPolicy';
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
//   - a PASS: when Home has drawn a fresh feed and Swift has been quiet a
//     moment (HomeScreen), ONE door at a time, in the order the tiles sit,
//     stopping the moment Home is covered, Swift goes to the background or the
//     phone goes offline;
//   - at the finger-down on a tile (pressRead: after it rests 180 ms, never on
//     a scroll), that door's reads, only when nothing is in memory.
//
// What a read ahead puts in memory is the server's own answer: the screen draws
// it at once and still re-reads behind it on open (these families stay at zero
// freshness, lib/appQueryPolicy), so a price, an order or a ride is never shown
// as final from here. Nothing here books, orders or pays; the Taxi screen still
// holds Request until its own "is a ride in progress?" lands (#2392).
//
// DATA COST [review S2-2]. Home's feed is re-read often (a focus while an order
// is live, a return after 30 s, a pull), so the limits do NOT hang on Home's
// reads or on what happens to be in the cache:
//   - no pass at all while Home shows a live order (the person is following
//     it, not browsing; Track has its own read at the finger-down);
//   - at most one pass per DOOR_FRESH_MS (10 min) and DOOR_PASSES_PER_SESSION
//     passes per account per app session;
//   - a read asked ahead is not asked again for DOOR_FRESH_MS (remembered here,
//     per account, whatever the cache did since), nor while the screen's own
//     answer is younger than that, nor while it is on its way; a read ahead
//     stays in memory that long too (gcTime);
//   - only first pages (a list the person scrolled is never cut back to one
//     page), never offline, and only the doors this person can open.
//
// RETRIES [review S2-1]. A read ahead keeps the app's own retry rule
// (retryRead). A screen that opens while it is on its way JOINS that read, and
// React Query fixes the retry rule when a read starts: a read ahead without
// retries would turn one dropped packet on a Guyana line into the screen's
// error state.
// ---------------------------------------------------------------------------

/** A door read ahead is not asked again within this, and Home starts at most one pass in it. */
export const DOOR_FRESH_MS = 10 * 60_000;

/** At most this many passes per account per app session (a long session costs no more than this). */
export const DOOR_PASSES_PER_SESSION = 12;

/** The doors Home reads ahead, in the order its tiles (then the Market tab) sit. */
export const HOME_DOORS = ['taxi', 'food', 'groceries', 'services', 'orders', 'favourites', 'market'] as const;
export type HomeDoor = (typeof HOME_DOORS)[number];

export interface DoorContext {
  signedIn: boolean;
  /** The customer's GRANTED place (lib/deviceLocation grantedLocationFix), or null. */
  here: { latitude: number; longitude: number } | null;
  /** The server has confirmed the Market tab (lib/homeReliability marketTabVisible). */
  marketVisible: boolean;
  /** Whose reads these are (the auth store's cache scope): another account starts its own limits. */
  scope?: string;
}

/** 'ahead': Home's pass (all the limits). 'press': a finger on the tile (only when nothing is in memory). */
export type DoorReadMode = 'ahead' | 'press';

interface DoorLedger {
  /** When each read was last asked ahead, by account and key. */
  asked: Map<string, number>;
  /** Each account's passes: when the last one started, and how many this session. */
  passes: Map<string, { at: number; count: number }>;
}

/** Per query client (one per app session; a test's own client starts clean). */
const ledgers = new WeakMap<QueryClient, DoorLedger>();
function ledgerOf(qc: QueryClient): DoorLedger {
  let ledger = ledgers.get(qc);
  if (!ledger) {
    ledger = { asked: new Map(), passes: new Map() };
    ledgers.set(qc, ledger);
  }
  return ledger;
}
const askedKey = (scope: string | undefined, queryKey: QueryKey) => `${scope ?? ''}|${hashKey(queryKey)}`;

/**
 * Whether a door's plain read should be asked now. Never while the same read is on its way. A press asks only when
 * nothing (or a failure) is in memory. A pass asks only when the read was not asked ahead in the last DOOR_FRESH_MS
 * AND the cache holds no answer younger than that.
 */
export function doorReadDue(qc: QueryClient, queryKey: QueryKey, mode: DoorReadMode = 'ahead', scope?: string, now = Date.now()): boolean {
  const state = qc.getQueryState(queryKey);
  if (state && state.fetchStatus !== 'idle') return false;
  if (mode === 'press') return state?.data === undefined;
  const asked = ledgerOf(qc).asked.get(askedKey(scope, queryKey));
  if (asked !== undefined && now - asked < DOOR_FRESH_MS) return false;
  if (!state || state.data === undefined) return true;
  return state.isInvalidated || now - state.dataUpdatedAt >= DOOR_FRESH_MS;
}

/** A list read page by page is asked ahead only when nothing is in memory: a fresh read here would cut the pages
 *  the person scrolled back to one, and the screen re-reads its own pages on open. */
function firstPageDue(qc: QueryClient, queryKey: QueryKey, mode: DoorReadMode, scope?: string, now = Date.now()): boolean {
  const state = qc.getQueryState(queryKey);
  if (state && (state.fetchStatus !== 'idle' || state.data !== undefined)) return false;
  if (mode === 'press') return true;
  const asked = ledgerOf(qc).asked.get(askedKey(scope, queryKey));
  return asked === undefined || now - asked >= DOOR_FRESH_MS;
}

function note(qc: QueryClient, queryKey: QueryKey, scope?: string) {
  ledgerOf(qc).asked.set(askedKey(scope, queryKey), Date.now());
}

function plain(qc: QueryClient, read: { queryKey: QueryKey; queryFn: () => Promise<unknown> }, mode: DoorReadMode, scope?: string): Promise<void> | undefined {
  if (!doorReadDue(qc, read.queryKey, mode, scope)) return undefined;
  note(qc, read.queryKey, scope);
  return qc.prefetchQuery({ queryKey: read.queryKey, queryFn: read.queryFn, retry: retryRead, gcTime: DOOR_FRESH_MS });
}

function pages<P>(
  qc: QueryClient,
  read: { queryKey: QueryKey; initialPageParam: P; queryFn: (ctx: { pageParam: P }) => Promise<unknown>; getNextPageParam: (last: any) => P | undefined },
  mode: DoorReadMode,
  scope?: string,
): Promise<void> | undefined {
  if (!firstPageDue(qc, read.queryKey, mode, scope)) return undefined;
  note(qc, read.queryKey, scope);
  return qc.prefetchInfiniteQuery({
    queryKey: read.queryKey,
    initialPageParam: read.initialPageParam,
    queryFn: ({ pageParam }) => read.queryFn({ pageParam: pageParam as P }),
    getNextPageParam: read.getNextPageParam,
    retry: retryRead,
    gcTime: DOOR_FRESH_MS,
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
 * Ask a door's first reads, or nothing when there is nothing to ask (see doorReadDue; a door this person cannot
 * open; offline). Resolves when every read it asked has settled; a failed read resolves too (the screen says so).
 */
export function readDoor(qc: QueryClient, door: HomeDoor, ctx: DoorContext, mode: DoorReadMode = 'ahead'): Promise<void> | undefined {
  if (!onlineManager.isOnline()) return undefined;
  const s = ctx.scope;
  switch (door) {
    case 'food':
      return plain(qc, doorStoreListKey('RESTAURANT', ctx.here), mode, s);
    case 'groceries':
      return plain(qc, doorStoreListKey('SUPERMARKET', ctx.here), mode, s);
    case 'services':
      return plain(qc, serviceCatalogRead(), mode, s);
    case 'taxi':
      // The booking form is for a signed-in person (TaxiScreen); a guest's Taxi door asks nothing.
      return ctx.signedIn ? settleAll([prefetchActiveRide(qc), plain(qc, rideCapabilitiesRead(), mode, s)]) : undefined;
    case 'orders':
      return ctx.signedIn ? settleAll([plain(qc, liveOrdersRead(), mode, s), pages(qc, ordersHistoryRead(), mode, s)]) : undefined;
    case 'favourites':
      return ctx.signedIn ? plain(qc, favoritesRead(), mode, s) : undefined;
    case 'market':
      return ctx.marketVisible ? pages(qc, marketItemsRead(), mode, s) : undefined;
    default:
      return undefined;
  }
}

/** A category tile's door (Home's "Find by category"), at the finger-down: the engine's answer Search opens on. */
export function readCategorySearch(qc: QueryClient, name: string, here: DoorContext['here']): Promise<void> | undefined {
  const q = name.trim();
  if (q.length < 2 || !onlineManager.isOnline()) return undefined;
  return plain(qc, searchRead(q, { type: undefined, lat: here?.latitude, lng: here?.longitude }), 'press');
}

/** A category rail chip's door (CategoryFeed), at the finger-down: the category's store list, as that screen asks. */
export function readCategoryFeed(qc: QueryClient, slug: string, here: DoorContext['here']): Promise<void> | undefined {
  if (!slug || !onlineManager.isOnline()) return undefined;
  return plain(qc, vendorsRead({
    category: slug,
    ...(here ? { lat: String(here.latitude), lng: String(here.longitude) } : {}),
  }), 'press');
}

/**
 * Read `doors` one at a time, each after the last has settled, while `stillWanted()` holds and the phone is online.
 * Resolves when done or stopped.
 */
export async function readDoorsInTurn(qc: QueryClient, doors: readonly HomeDoor[], ctx: DoorContext, stillWanted: () => boolean): Promise<void> {
  for (const door of doors) {
    if (!stillWanted() || !onlineManager.isOnline()) return;
    await readDoor(qc, door, ctx, 'ahead')?.catch(() => undefined);
  }
}

/** Whether this account may start a pass now (one per DOOR_FRESH_MS, DOOR_PASSES_PER_SESSION per session). */
export function doorPassAllowed(qc: QueryClient, scope: string | undefined, now = Date.now()): boolean {
  const last = ledgerOf(qc).passes.get(scope ?? '');
  return !last || (now - last.at >= DOOR_FRESH_MS && last.count < DOOR_PASSES_PER_SESSION);
}

function notePass(qc: QueryClient, scope: string | undefined) {
  const passes = ledgerOf(qc).passes;
  const last = passes.get(scope ?? '');
  passes.set(scope ?? '', { at: Date.now(), count: (last?.count ?? 0) + 1 });
}

/** How long Home's feed must have been on screen, with Swift quiet, before its doors are read ahead. */
export const HOME_DOORS_IDLE_MS = 1_500;

/**
 * Home's reads ahead: after HOME_DOORS_IDLE_MS of quiet (no read in flight), while `enabled` (Home in front, a feed
 * of content) and Home shows no live order, when a pass is allowed (doorPassAllowed). `feedAt` (the feed's dataUpdatedAt)
 * re-arms it after a fresh feed; the pass limits, not Home's reads, decide whether anything is asked.
 */
export function useHomeDoorReads(enabled: boolean, feedAt: number, ctx: DoorContext, showsLiveOrder: boolean): void {
  const qc = useQueryClient();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  // No pass while Home shows a live order: the person is following it, and Home re-reads its feed often then.
  const wantsPass = enabled && !showsLiveOrder;
  useEffect(() => {
    if (!wantsPass || !doorPassAllowed(qc, ctxRef.current.scope)) return undefined;
    let wanted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A read still on its way (an ad, the category rail, a store's menu): wait for the next quiet moment.
    const fire = () => {
      timer = undefined;
      if (!wanted) return;
      if (qc.isFetching() > 0) { timer = setTimeout(fire, HOME_DOORS_IDLE_MS); return; }
      const context = ctxRef.current;
      if (!doorPassAllowed(qc, context.scope) || !onlineManager.isOnline()) return;
      notePass(qc, context.scope);
      void readDoorsInTurn(qc, HOME_DOORS, context, () => wanted);
    };
    timer = setTimeout(fire, HOME_DOORS_IDLE_MS);
    return () => {
      wanted = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [wantsPass, feedAt, qc]);
}

/** The press handlers for a Home tile's door (`{...doorPress('food')}`), or nothing to spread for a door with no
 *  read (Send, Scan). */
export function useDoorPress(ctx: DoorContext): (door: HomeDoor | null) => PressReadHandlers | Record<string, never> {
  const qc = useQueryClient();
  const pressRead = usePressRead();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  return useCallback(
    (door) => (door ? pressRead(() => readDoor(qc, door, ctxRef.current, 'press')) : {}),
    [qc, pressRead],
  );
}
