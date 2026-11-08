import { useQuery } from '@tanstack/react-query';
import type { ServiceCatalog } from '@swift/types';
import { api } from '../../services/api';

/** Category choices and availability come from the same server policy that
 * validates profile saves. Never fall back to a divergent hardcoded list. */
export function useServiceCatalog() {
  return useQuery<ServiceCatalog>(serviceCatalogRead());
}

/** [APP-SPEED D] The catalogue's key, read and freshness, shared by the Services screen and the read Home asks
 *  ahead of the Services door (hooks/homeDoors). */
export function serviceCatalogRead() {
  return {
    queryKey: ['services', 'catalog', 1] as const,
    queryFn: async (): Promise<ServiceCatalog> => {
      const response = await api.get<{ data: ServiceCatalog }>('/services/catalog');
      const catalog = response.data.data;
      if (catalog?.version !== 1 || !Array.isArray(catalog.categories)) {
        throw new Error('Unsupported services catalogue');
      }
      return catalog;
    },
    staleTime: 60_000,
    retry: 1,
  };
}
