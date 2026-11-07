import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { prefetchVendor } from './customer';
import { useLocationStore } from '../stores/locationStore';
import { grantedLocationFix } from '../lib/deviceLocation';

/** [APP-SPEED A] The press-in prefetch for store and dish cards (Home, Search, Favourites, Market):
 *  the store's menu is asked for at the finger-down, with the customer's granted place exactly as
 *  the store page asks (hooks/customer prefetchVendor). */
export function useVendorPrefetch(): (vendorId: string | null | undefined) => void {
  const qc = useQueryClient();
  return useCallback((vendorId) => {
    if (!vendorId) return;
    const { latitude, longitude, status } = useLocationStore.getState();
    const here = grantedLocationFix(latitude, longitude, status);
    prefetchVendor(qc, vendorId, here ? { lat: here.latitude, lng: here.longitude } : null);
  }, [qc]);
}
