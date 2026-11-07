import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { prefetchVendor } from './customer';
import { useLocationStore } from '../stores/locationStore';
import { grantedLocationFix } from '../lib/deviceLocation';
import { usePressRead, type PressReadHandlers } from './pressRead';

export { PRESS_READ_DELAY_MS, usePressRead, type PressReadHandlers } from './pressRead';

/** [APP-SPEED A] The press-held read of a store's menu for store and dish cards (Home, Search,
 *  Favourites), with the customer's granted place exactly as the store page asks
 *  (hooks/customer prefetchVendor). Spread the result on the card: `{...storeRead(v.id)}`. */
export function useVendorPrefetch(): (vendorId: string | null | undefined) => PressReadHandlers {
  const qc = useQueryClient();
  const pressRead = usePressRead();
  return useCallback((vendorId) => pressRead(() => {
    if (!vendorId) return undefined;
    const { latitude, longitude, status } = useLocationStore.getState();
    const here = grantedLocationFix(latitude, longitude, status);
    return prefetchVendor(qc, vendorId, here ? { lat: here.latitude, lng: here.longitude } : null);
  }), [qc, pressRead]);
}
