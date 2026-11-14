'use client';

import { useQuery } from '@tanstack/react-query';
import { getDeliveryStatus } from '@/lib/vendor-api';
import { storeKey } from '@/lib/store-scope';

/**
 * [RIDER-SAFE 4/5 · COORD ruling 29 Oct 2026] The store sees WHY customers
 * cannot order delivery right now: Swift paused delivery in its area, or its
 * own orders are waiting for riders (new delivery orders pause by themselves
 * and restart when a rider takes one). Pickup stays open either way. Nothing
 * is shown while delivery is open, or when the read fails.
 */
export function DeliveryStatusNotice({ storeId }: { storeId: string | null }) {
  const status = useQuery({ queryKey: storeKey(storeId, 'delivery-status'), queryFn: getDeliveryStatus, refetchInterval: 60_000 });
  const s = status.data;
  // [follow-up · review B S4-9] Every store role sees a Dragontail branch's offline kitchen link here.
  const link = s?.kitchenLink?.offline === true && (
    <div role="status" aria-label="Kitchen link offline" className="sw-card border border-[var(--swift-red)] p-4">
      <p className="font-semibold">Kitchen link offline, orders on tablet</p>
      <p className="mt-1 text-sm">Dragontail is not answering, so new orders ring here: make them from this tablet. Swift keeps checking and switches back by itself.</p>
    </div>
  );
  if (!s || s.deliveryOpen || !s.message) return link || null;
  return (
    <>
      {link}
      <div role="status" aria-label="Delivery paused" className="sw-card border border-[var(--swift-red)] p-4">
        <p className="font-semibold">{s.reason === 'SWIFT_PAUSED' ? 'Delivery is paused by Swift' : 'New delivery orders are paused'}</p>
        <p className="mt-1 text-sm">{s.message}</p>
      </div>
    </>
  );
}
