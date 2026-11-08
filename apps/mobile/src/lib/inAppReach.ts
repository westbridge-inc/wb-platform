/**
 * [CALLS-REACH · live test 8 Nov 2026] Who can be RUNG in the app, decided once for the whole app.
 *
 * Before: a phone registered to be rung only while a "Call in app" control was on screen. A customer on a
 * store pickup order never sees one (they call stores by the published number), so the store's in-app call
 * could never reach them; the same for a rider in the background, a customer on Home, a driver on another tab.
 *
 * Now: the person is on at least one live order (as customer, rider, driver, store owner or staff), read from
 * what the app already holds in memory, and the phone registers. These are the pure parts: the live-order
 * signal from the cached reads, and when Android's microphone may be asked for (once, never a nag).
 *
 * Pure: no React, no network, no native module.
 */

import type { QueryClient } from '@tanstack/react-query';

/** Finished orders (the server's TERMINAL_ORDER_STATUSES, custody FINISHED). Anything else is live. */
const FINISHED = new Set(['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED', 'RETURNED']);

/** Who the person is on their live orders: it picks the words of the microphone explanation. */
export type ReachAudience = 'customer' | 'partner';

/**
 * live: on at least one live order. none: the reads the app holds say there is none. unknown: nothing read
 * yet (never a reason to unregister).
 */
export interface ReachSignal {
  state: 'live' | 'none' | 'unknown';
  /** The live orders' ids (for remembering a microphone refusal per order). */
  orderIds: string[];
  audience: ReachAudience | null;
}

/**
 * The reads the app already makes, exactly as React Query holds them. `undefined` = not read (yet).
 * - customerLive: GET /customer/orders?live=true ({ items }), every vertical, taxi rides included.
 * - activeRide: the passenger's active ride (null when none).
 * - moverActive: each mover kind's active job (null when none).
 * - storeOrders: the store board's orders (an array).
 */
export interface ReachSources {
  customerLive?: unknown;
  activeRide?: unknown;
  moverActive?: unknown[];
  storeOrders?: unknown;
}

/** A row the server would still call live, and its id (if it has one). */
function liveRow(row: unknown): { live: boolean; id: string | null } {
  if (!row || typeof row !== 'object') return { live: false, id: null };
  const r = row as { id?: unknown; orderId?: unknown; status?: unknown };
  const status = typeof r.status === 'string' ? r.status.toUpperCase() : '';
  const id = typeof r.orderId === 'string' && r.orderId ? r.orderId : typeof r.id === 'string' && r.id ? r.id : null;
  return { live: !FINISHED.has(status), id };
}

export function reachSignal(sources: ReachSources): ReachSignal {
  let known = false;
  const customer: string[] = [];
  const partner: string[] = [];
  let customerLive = false;
  let partnerLive = false;

  const take = (rows: unknown[], into: string[]): boolean => {
    let any = false;
    for (const row of rows) {
      const { live, id } = liveRow(row);
      if (!live) continue;
      any = true;
      if (id) into.push(id);
    }
    return any;
  };

  const list = sources.customerLive as { items?: unknown } | null | undefined;
  if (list && typeof list === 'object' && Array.isArray(list.items)) {
    known = true;
    customerLive = take(list.items, customer) || customerLive;
  }
  if (sources.activeRide !== undefined) {
    known = true;
    customerLive = take([sources.activeRide], customer) || customerLive;
  }
  for (const job of sources.moverActive ?? []) {
    if (job === undefined) continue;
    known = true;
    partnerLive = take([job], partner) || partnerLive;
  }
  if (Array.isArray(sources.storeOrders)) {
    known = true;
    partnerLive = take(sources.storeOrders, partner) || partnerLive;
  }

  const orderIds = [...new Set([...customer, ...partner])];
  if (customerLive || partnerLive) return { state: 'live', orderIds, audience: customerLive ? 'customer' : 'partner' };
  return { state: known ? 'none' : 'unknown', orderIds: [], audience: null };
}

/**
 * The React Query keys of the reads above, exactly as the hooks name them (hooks/customer useLiveOrders,
 * hooks/rides useActiveRide, hooks/mover useActiveJob, hooks/vendorops useVendorOrders). A census test holds
 * them to the hooks' source. Only read here: nothing new is fetched or polled for them.
 */
export const REACH_KEYS = {
  customerLive: ['customer', 'orders', 'live'],
  activeRide: ['rides', 'active'],
  /** + the mover kind: ['mover', 'active', kind]. The stacked rider's ['mover', 'active', kind, 'legs'] is not a job. */
  moverActive: ['mover', 'active'],
  storeOrders: ['vendor', 'orders'],
} as const;

const sameKey = (key: readonly unknown[], want: readonly unknown[]) => key.length === want.length && want.every((part, i) => key[i] === part);
const isMoverActive = (key: readonly unknown[]) => key.length === 3 && key[0] === REACH_KEYS.moverActive[0] && key[1] === REACH_KEYS.moverActive[1];

/** Does a change to this query move the live-order signal? */
export function isReachKey(key: readonly unknown[]): boolean {
  return sameKey(key, REACH_KEYS.customerLive) || sameKey(key, REACH_KEYS.activeRide) || sameKey(key, REACH_KEYS.storeOrders) || isMoverActive(key);
}

/** The signal from what the app holds in memory now. Reads only (never a fetch). */
export function reachSignalFromCache(client: Pick<QueryClient, 'getQueryData' | 'getQueriesData'>): ReachSignal {
  return reachSignal({
    customerLive: client.getQueryData([...REACH_KEYS.customerLive]),
    activeRide: client.getQueryData([...REACH_KEYS.activeRide]),
    moverActive: client.getQueriesData({ queryKey: [...REACH_KEYS.moverActive] })
      .filter(([key]) => isMoverActive(key))
      .map(([, data]) => data),
    storeOrders: client.getQueryData([...REACH_KEYS.storeOrders]),
  });
}

// ---------------------------------------------------------------------------
// Android's microphone: asked once, with Swift's own words first, never a nag.
// ---------------------------------------------------------------------------

/** After a refusal, Swift waits this long before asking again, and only for an order it has not asked about. */
export const MIC_ASK_QUIET_MS = 7 * 24 * 60 * 60_000;
/** How many refused orders are remembered (oldest dropped). Ids only: nothing personal. */
const MIC_ASKED_ORDERS_KEPT = 20;

export interface MicMemory {
  /** When the person last said no (to Swift's words or to the system prompt). */
  at: number;
  /** The live orders at that moment: never asked again while one of them is live. */
  orders: string[];
  /** Android answered "don't ask again": only Settings can turn it on now, so Swift never asks. */
  never?: boolean;
}

export function mayAskForMic(memory: MicMemory | null, orderIds: readonly string[], now: number): boolean {
  if (!memory) return true;
  if (memory.never) return false;
  if (orderIds.some((id) => memory.orders.includes(id))) return false;
  return now - memory.at >= MIC_ASK_QUIET_MS;
}

export function rememberMicRefusal(memory: MicMemory | null, orderIds: readonly string[], now: number, never = false): MicMemory {
  const orders = [...new Set([...orderIds, ...(memory?.orders ?? [])])].slice(0, MIC_ASKED_ORDERS_KEPT);
  return { at: now, orders, ...(never || memory?.never ? { never: true } : {}) };
}

/** What was stored, read defensively (an old or damaged value is "never asked"). */
export function parseMicMemory(raw: string | null | undefined): MicMemory | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<MicMemory> | null;
    if (!v || typeof v.at !== 'number' || !Number.isFinite(v.at) || !Array.isArray(v.orders)) return null;
    const orders = v.orders.filter((x): x is string => typeof x === 'string').slice(0, MIC_ASKED_ORDERS_KEPT);
    return { at: v.at, orders, ...(v.never === true ? { never: true } : {}) };
  } catch {
    return null;
  }
}
