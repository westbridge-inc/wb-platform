/** @jsxImportSource react */
import React from 'react';
import { FlatList, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { color, space } from '@swift/ui';
import { useDiscoveryCategories, useVendors } from '../../../hooks/customer';
import { useLocationStore } from '../../../stores/locationStore';
import { grantedLocationFix } from '../../../lib/deviceLocation';
import { distanceLabel } from '../../../lib/geo';
import { vendorPhoto } from '../../../lib/images';
import { CartBar, useCartBarClearance, Chip, EmptyState, ErrorState, Header, RatingMeta, Screen, T, VendorRow } from '../../../kit';
import { ListSkeleton } from '../../../kit/skeletons';
import { OFFLINE_FIRST_READ_MESSAGE, offlineFirstRead } from '../../../lib/offlineRead';
import { useVendorPrefetch } from '../../../hooks/storeDoor';
import { storePreviewOf } from '../../../lib/doorPreview';

// ---------------------------------------------------------------------------
// The category feed (#17 6.3): chip tap lands here. The EXISTING store-list
// pipeline (+category param) feeds it — open stores first, closed under a
// quiet honest divider; DISH/DIETARY/AISLE cards carry "{n} items"; the empty
// state (availability changed mid-session) offers sibling categories that DO
// have someone open. Tapping a store opens the normal storefront.
// ---------------------------------------------------------------------------

export function CategoryFeedScreen() {
  // [E09] While the cart bar floats over the list, the last row must scroll clear of it.
  const cartClearance = useCartBarClearance();
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { slug, name } = route.params as { slug: string; name: string };
  // [APP-SPEED D] A store's menu is asked for at the finger-down on its row (the door Home's cards already have).
  const prefetchStore = useVendorPrefetch();
  const { latitude, longitude, status } = useLocationStore();
  const locationFix = grantedLocationFix(latitude, longitude, status);

  const vendorsQ = useVendors<any>({
    category: slug,
    ...(locationFix ? { lat: String(locationFix.latitude), lng: String(locationFix.longitude) } : {}),
  });
  const rail = useDiscoveryCategories(locationFix?.latitude, locationFix?.longitude);

  const vendors: any[] = vendorsQ.data?.data ?? vendorsQ.data ?? [];
  const open = vendors.filter((v) => v.isCurrentlyOpen);
  const closed = vendors.filter((v) => !v.isCurrentlyOpen);
  const siblings = (rail.data?.categories ?? []).filter((c) => c.slug !== slug).slice(0, 3);

  const row = (v: any) => (
    <VendorRow
      image={vendorPhoto(v)}
      name={v.name}
      brand={v.brand}
      place={v.addressLine1 ?? v.city}
      meta={
        <RatingMeta
          rating={v.displayRating ?? null}
          bucket={v.ratingBucket}
          topRated={v.topRated}
          extra={locationFix ? distanceLabel(v.distanceKm) : undefined}
        />
      }
      sub={v.itemsInCategory ? `${v.itemsInCategory} ${name.toLowerCase()} items` : v.etaMin ? `~${v.etaMin} min delivery` : undefined}
      {...prefetchStore(v.id)}
      onPress={() => navigation.navigate('Restaurant', { vendorId: v.id, preview: storePreviewOf(v) })}
    />
  );

  return (
    <Screen>
      <Header title={name} />
      {offlineFirstRead(vendorsQ) ? (
        // [APP-SPEED D · review S3] A first read waiting for a connection is the offline state, never "nothing here".
        <ErrorState message={OFFLINE_FIRST_READ_MESSAGE} onRetry={() => { void vendorsQ.refetch(); }} />
      ) : vendorsQ.isLoading ? (
        // [APP-SPEED D] The rows' shapes on the first frame (the chip on Home starts this read at the finger-down).
        <ListSkeleton />
      ) : vendorsQ.isError ? (
        <ErrorState onRetry={() => vendorsQ.refetch()} />
      ) : vendors.length === 0 ? (
        <View style={{ flex: 1 }}>
          <EmptyState
            icon="clock"
            title={`No ${name.toLowerCase()} spots are open right now`}
            body="Check back soon."
          />
          {siblings.length > 0 ? (
            <View style={{ alignItems: 'center', paddingBottom: space['3xl'] + cartClearance }}>
              <T variant="caption" tone="muted" style={{ marginBottom: space.md }}>
                Open now instead
              </T>
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                {siblings.map((c) => (
                  <Chip
                    key={c.slug}
                    label={c.name}
                    onPress={() => navigation.setParams({ slug: c.slug, name: c.name })}
                  />
                ))}
              </View>
            </View>
          ) : null}
        </View>
      ) : (
        <FlatList
          data={[...open, ...closed]}
          keyExtractor={(v) => v.id}
          contentContainerStyle={{ paddingHorizontal: space['2xl'], gap: space.md, paddingBottom: space['3xl'] + cartClearance }}
          renderItem={({ item: v, index }) => (
            <>
              {index === open.length && closed.length > 0 ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginVertical: space.sm }}>
                  <View style={{ flex: 1, height: 1, backgroundColor: color.border.subtle }} />
                  <T variant="caption" tone="muted">Closed now</T>
                  <View style={{ flex: 1, height: 1, backgroundColor: color.border.subtle }} />
                </View>
              ) : null}
              {row(v)}
            </>
          )}
        />
      )}
      {/* [E09] A shopper who has added items can always reach the Cart tab. */}
      <CartBar />
    </Screen>
  );
}
