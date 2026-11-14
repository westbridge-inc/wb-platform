'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getProfile, updateProfile } from '@/lib/vendor-api';
import { storeKey } from '@/lib/store-scope';
// [STORE-PREP] The app's own rules and words for the usual preparation time (plain file, imported as is).
import { PREP_TIME_CHOICES, prepChipLabel, storedPrepTime, usualPrepHeading, usualPrepLine } from '../../../../../mobile/src/modules/vendor/prepTime';

type ProfileStores = { vendors?: Array<{ id: string; vendorType?: string; estimatedPrepTime?: unknown }>; myRole?: string };

/**
 * [STORE-PREP · parity audit C3, owner ruling 14 Nov 2026] The store's usual preparation time (Vendor.estimatedPrepTime):
 * the owner or a manager picks one of Accept's own choices (10-60 min), and every new order starts Accept at it (the
 * order carries it from checkout). Staff can still pick another time on each order. Stores that cook or pack (a
 * Services business's bookings take no preparation time). The app's Account has the same card.
 */
export function PrepTimeCard({ storeId }: { storeId: string | null }) {
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: storeKey(storeId, 'profile'), queryFn: getProfile });
  const data = profile.data as ProfileStores | undefined;
  const store = data?.vendors?.find((v) => v.id === storeId) ?? (data?.vendors?.length === 1 ? data.vendors[0] : undefined);
  const manager = data?.myRole === 'OWNER' || data?.myRole === 'MANAGER';
  const value = storedPrepTime(store);
  const [pick, setPick] = useState<number | null>(value);
  useEffect(() => { setPick(value); }, [value]);

  const save = useMutation({
    mutationFn: (estimatedPrepTime: number) => updateProfile({ estimatedPrepTime }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'profile') }),
  });

  // A failed read: the settings page's own "Couldn't load your store details" (same query) says so.
  if (profile.isError) return null;
  if (!manager || !store || store.vendorType === 'SERVICE') return null;
  const dirty = pick != null && pick !== value;
  return (
    <div className="sw-card p-6">
      <h2 className="font-bold" id="usual-prep-title">{usualPrepHeading(store.vendorType)}</h2>
      <p className="mt-1 text-sm text-[var(--swift-muted)]">{usualPrepLine(pick)}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-labelledby="usual-prep-title">
        {PREP_TIME_CHOICES.map((minutes) => (
          <button key={minutes} type="button" className="sw-chip" aria-pressed={pick === minutes} disabled={save.isPending}
            onClick={() => { save.reset(); setPick(minutes); }}>
            {prepChipLabel(minutes)}
          </button>
        ))}
      </div>
      {save.isError ? (
        <p role="alert" className="mt-2 text-sm text-[var(--swift-red)]">
          {save.error instanceof Error && save.error.message ? save.error.message : 'That could not be saved. Check your connection and try again.'}
        </p>
      ) : null}
      {dirty ? (
        <button type="button" onClick={() => save.mutate(pick!)} disabled={save.isPending}
          className="mt-3 rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      ) : null}
    </div>
  );
}
