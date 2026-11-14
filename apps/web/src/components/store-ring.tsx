'use client';

import { useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import NewOrderTakeover from '@/components/NewOrderTakeover';
import { BOARD_ORDERS_POLL, getBoardOrders } from '@/lib/vendor-api';
import { storeKey } from '@/lib/store-scope';
import { useFeedPollInterval } from '@/lib/store-live-feed';
import { requestOpenOrder } from '@/lib/open-order-request';

/**
 * [STORE-BOARD S1 · parity audit B1] The new-order ring on EVERY dashboard page, as the app's alert layer sits above
 * all its tabs: the takeover, its chime and the flashing tab title used to live on the Orders page only, so a store
 * on Menu, Settings, Insights or Team heard nothing. Mounted once, by the dashboard shell (its own chunk, loaded
 * after the page). It reads the board's own query (same key, same read, same poll), so the Orders page and the ring
 * share one read and one set of orders, and the Orders page no longer mounts a ring of its own (never two chimes).
 * The takeover keeps its own rules: an order already waiting when the page opens rings, an answered or expired one
 * does not, and a browser that keeps sound off until a press is told so.
 *
 * Drawn straight into <body>: a page's open dialog (components/modal) makes everything that was on the page inert,
 * and a ring that arrives while one is open must still take the screen and its presses.
 */
export function StoreRing({ storeId, toOrders }: { storeId: string; toOrders?: () => void }) {
  const poll = useFeedPollInterval(storeId, ...BOARD_ORDERS_POLL);
  const board = useQuery({ queryKey: storeKey(storeId, 'orders'), queryFn: getBoardOrders, refetchInterval: poll });
  // The Orders page opens the order; from any other page the ring goes there first (`toOrders`).
  const open = (id: string) => { if (!requestOpenOrder(id)) toOrders?.(); };
  return createPortal(<NewOrderTakeover orders={board.data?.orders ?? []} onOpenOrder={open} />, document.body);
}
