// ---------------------------------------------------------------------------
// [STORE-ALERT-RECONNECT · S4-2] The new-order screens the store answered on
// this phone (Accept, Reject, "View later", or settled while on screen).
//
// Kept per signed-in account and order on the device, so a cold start or an
// app update does not ring again for an order the store already put off. Never
// shared across accounts: the memory names its account, another account starts
// empty, and signing out wipes it. Small: an order is forgotten once the board
// shows it is no longer waiting (left PENDING) or its accept window has passed.
// The server's own reminders behind "View later" are unchanged.
// ---------------------------------------------------------------------------

/** A synchronous key-value store (the app's encrypted device storage). */
export type HandledTakeoverStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

/** Orders remembered per store as answered on this phone; far more than a kitchen holds open. */
export const HANDLED_TAKEOVERS_REMEMBERED = 200;
/** How long an order with no known accept window is remembered (a booking request's window can be a day). */
export const HANDLED_TAKEOVER_FALLBACK_MS = 48 * 60 * 60_000;
export const HANDLED_TAKEOVERS_STORAGE_KEY = 'swift.storeAlerts.handled.v1';

type Memory = { userId: string | null; stores: Map<string, Map<string, number>> };

let storage: HandledTakeoverStorage | null = null;
let memory: Memory | null = null;

/** Wires the device storage (stores/authStore, which also owns sign-out). Without it: this run only. */
export function bindHandledTakeoverStorage(next: HandledTakeoverStorage | null): void {
  storage = next;
  memory = null;
}

function readStored(userId: string): Map<string, Map<string, number>> {
  const stores = new Map<string, Map<string, number>>();
  let raw: string | null = null;
  try {
    raw = storage?.getItem(HANDLED_TAKEOVERS_STORAGE_KEY) ?? null;
  } catch {
    return stores;
  }
  if (!raw) return stores;
  try {
    const parsed = JSON.parse(raw) as { u?: unknown; s?: unknown };
    // Another account's memory is never read (it is replaced on the next write).
    if (parsed?.u !== userId || !parsed.s || typeof parsed.s !== 'object') return stores;
    for (const [vendorId, orders] of Object.entries(parsed.s as Record<string, unknown>)) {
      if (!orders || typeof orders !== 'object') continue;
      const kept = new Map<string, number>();
      for (const [orderId, until] of Object.entries(orders as Record<string, unknown>)) {
        if (typeof until === 'number' && Number.isFinite(until)) kept.set(orderId, until);
      }
      if (kept.size > 0) stores.set(vendorId, kept);
    }
  } catch {
    // Unreadable: start empty (at worst an order rings once more).
  }
  return stores;
}

function memoryFor(userId: string | null): Memory {
  if (!memory || memory.userId !== userId) {
    memory = { userId, stores: userId ? readStored(userId) : new Map() };
  }
  return memory;
}

function save(m: Memory): void {
  // Signed out (no account): this run only, never on the device.
  if (!m.userId || !storage) return;
  const s: Record<string, Record<string, number>> = {};
  for (const [vendorId, orders] of m.stores) if (orders.size > 0) s[vendorId] = Object.fromEntries(orders);
  try {
    if (Object.keys(s).length === 0) storage.removeItem(HANDLED_TAKEOVERS_STORAGE_KEY);
    else storage.setItem(HANDLED_TAKEOVERS_STORAGE_KEY, JSON.stringify({ u: m.userId, s }));
  } catch {
    // Best effort: losing a write costs one more ring after a restart, never a missed order.
  }
}

/** The store answered this order's new-order screen on this phone; remembered until `until` (ms). */
export function markTakeoverHandled(userId: string | null, vendorId: string, orderId: string, until: number): void {
  const m = memoryFor(userId);
  let orders = m.stores.get(vendorId);
  if (!orders) {
    orders = new Map();
    m.stores.set(vendorId, orders);
  }
  orders.delete(orderId);
  orders.set(orderId, until);
  while (orders.size > HANDLED_TAKEOVERS_REMEMBERED) orders.delete(orders.keys().next().value!);
  save(m);
}

export function takeoverHandled(userId: string | null, vendorId: string, orderId: string, now: number = Date.now()): boolean {
  const until = memoryFor(userId).stores.get(vendorId)?.get(orderId);
  return until !== undefined && until > now;
}

/** Forget what no longer waits: an order the board shows outside PENDING, or past its accept window.
 *  An order still waiting is kept until the end of its (possibly moved) accept window. */
export function pruneHandledTakeovers(userId: string | null, vendorId: string, board: unknown, now: number): void {
  const m = memoryFor(userId);
  const orders = m.stores.get(vendorId);
  if (!orders || orders.size === 0) return;
  const rows = new Map<string, Record<string, unknown>>();
  if (Array.isArray(board)) {
    for (const o of board as Array<Record<string, unknown> | null | undefined>) {
      const id = o?.['id'];
      if (typeof id === 'string' && o) rows.set(id, o);
    }
  }
  let changed = false;
  for (const [orderId, until] of [...orders]) {
    const row = rows.get(orderId);
    if (row && row['status'] !== 'PENDING') {
      orders.delete(orderId);
      changed = true;
      continue;
    }
    const windowEnd = row ? acceptWindowEnd(row) : null;
    const end = windowEnd ?? until;
    if (end <= now) {
      orders.delete(orderId);
      changed = true;
    } else if (end !== until) {
      orders.set(orderId, end);
      changed = true;
    }
  }
  if (orders.size === 0) m.stores.delete(vendorId);
  if (changed) save(m);
}

/** The order's accept window end (its respondBy), or null when the row has none. */
export function acceptWindowEnd(row: unknown): number | null {
  const respondBy = (row as Record<string, unknown> | null | undefined)?.['respondBy'];
  if (typeof respondBy !== 'string') return null;
  const at = Date.parse(respondBy);
  return Number.isFinite(at) ? at : null;
}

/** Sign-out (and any session end): this phone forgets every answered screen, on the device too. */
export function forgetHandledTakeovers(): void {
  memory = null;
  try {
    storage?.removeItem(HANDLED_TAKEOVERS_STORAGE_KEY);
  } catch {
    // Unreadable storage holds nothing another account can read (the account is checked on read).
  }
}

/** Test seam: drop this run's memory (the device copy stays, as after a restart). */
export function resetHandledTakeovers(): void {
  memory = null;
}
