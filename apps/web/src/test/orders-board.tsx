import OrdersPage from '@/app/dashboard/orders/page';
import { StoreRing } from '@/components/store-ring';
import { useStoreId } from '@/lib/store-scope';

/**
 * [STORE-BOARD S1] The Orders page as the dashboard draws it: the page, and above it the shell's new-order ring (the
 * popup, chime and flashing title), which the dashboard shell mounts once for every page. Tests of the popup on the
 * board render this instead of the page alone.
 */
export function OrdersBoard() {
  const storeId = useStoreId();
  return <>{storeId ? <StoreRing storeId={storeId} /> : null}<OrdersPage /></>;
}
