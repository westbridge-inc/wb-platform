import { useEffect } from 'react';

// ---------------------------------------------------------------------------
// [STORE-BOARD S1 · parity audit B1] The new-order ring lives in the dashboard shell (every page), the order window
// on the Orders page. "View order" on the ring asks for the order here: the Orders page opens it at once when it is
// on screen; otherwise the request waits, the ring goes to the Orders page, and the page opens it as it mounts.
// ---------------------------------------------------------------------------

let waiting: string | null = null;
const openers = new Set<(_id: string) => void>();

/** Ask for an order's window. True when an Orders page took it now; false when it waits for the next one. */
export function requestOpenOrder(id: string): boolean {
  if (openers.size > 0) {
    for (const open of openers) open(id);
    return true;
  }
  waiting = id;
  return false;
}

/** The Orders page: open what the ring asks for, including a request made before this page was on screen. */
export function useOpenOrderRequests(open: (_id: string) => void): void {
  useEffect(() => {
    if (waiting) {
      const id = waiting;
      waiting = null;
      open(id);
    }
    openers.add(open);
    return () => { openers.delete(open); };
  }, [open]);
}
