import { customerDeciding } from './storeOrderRules';

// ---------------------------------------------------------------------------
// [STORE-ALERT-RECONNECT] The new-order screen no longer depends on the socket
// alone. The board's own read (its poll, a reconnect, the app returning to the
// screen) and a push that arrives while the store app is open raise it too, for
// every order still waiting for this store's answer. Each order rises once:
// one the store already answered here (Accept, Reject, "View later", or it
// settled while on screen) is not raised again by these paths. The server's
// own order:new keeps raising as it always did.
// ---------------------------------------------------------------------------

export type TakeoverEntry = { orderId: string; orderNumber?: string };

/** Orders remembered per store as answered on this phone; far more than a kitchen holds open. */
export const HANDLED_TAKEOVERS_REMEMBERED = 200;

const handled = new Map<string, Map<string, true>>();

/** The store answered this order's new-order screen on this phone. */
export function markTakeoverHandled(vendorId: string, orderId: string): void {
  let orders = handled.get(vendorId);
  if (!orders) {
    orders = new Map();
    handled.set(vendorId, orders);
  }
  orders.delete(orderId);
  orders.set(orderId, true);
  while (orders.size > HANDLED_TAKEOVERS_REMEMBERED) orders.delete(orders.keys().next().value!);
}

export function takeoverHandled(vendorId: string, orderId: string): boolean {
  return handled.get(vendorId)?.has(orderId) === true;
}

/** Test seam. */
export function resetHandledTakeovers(): void {
  handled.clear();
}

/**
 * The board's orders that are waiting for THIS store's answer right now: still
 * PENDING, not waiting on the customer's out-of-stock reply, inside their
 * accept window (a lapsed one is the server's to cancel), and of this store
 * (an all-branches row of another branch is not). `busy` = orders with a store
 * tap already on its way to the server.
 */
export function waitingForStore(
  board: unknown,
  vendorId: string,
  now: number,
  busy: ReadonlySet<string> = new Set(),
): TakeoverEntry[] {
  if (!Array.isArray(board)) return [];
  const out: TakeoverEntry[] = [];
  for (const o of board as Array<Record<string, unknown> | null | undefined>) {
    const id = o?.['id'];
    if (typeof id !== 'string' || !id || busy.has(id)) continue;
    if (o?.['status'] !== 'PENDING' || customerDeciding(o as never)) continue;
    const rowStore = o?.['vendorId'];
    if (typeof rowStore === 'string' && rowStore !== vendorId) continue;
    const respondBy = typeof o?.['respondBy'] === 'string' ? Date.parse(o['respondBy'] as string) : Number.NaN;
    if (Number.isFinite(respondBy) && respondBy <= now) continue;
    const orderNumber = o?.['orderNumber'];
    out.push({ orderId: id, ...(typeof orderNumber === 'string' ? { orderNumber } : {}) });
  }
  return out;
}

/** The new-order push's data, when it is one for this store. */
export function storeAlertFromPush(data: Record<string, unknown>, vendorId: string): TakeoverEntry | null {
  if (data['kind'] !== 'vendor_order_alert') return null;
  const orderId = data['orderId'];
  if (typeof orderId !== 'string' || !orderId) return null;
  const pushStore = data['vendorId'];
  if (typeof pushStore === 'string' && pushStore && pushStore !== vendorId) return null;
  const orderNumber = data['orderNumber'];
  return { orderId, ...(typeof orderNumber === 'string' && orderNumber ? { orderNumber } : {}) };
}

/** Add entries the queue does not hold yet (FIFO); the same array when nothing is new (no re-render). */
export function withRaised(
  queue: TakeoverEntry[],
  entries: TakeoverEntry[],
  skip: (orderId: string) => boolean = () => false,
): TakeoverEntry[] {
  const add: TakeoverEntry[] = [];
  for (const e of entries) {
    if (skip(e.orderId)) continue;
    if (queue.some((x) => x.orderId === e.orderId) || add.some((x) => x.orderId === e.orderId)) continue;
    add.push(e);
  }
  return add.length ? [...queue, ...add] : queue;
}
