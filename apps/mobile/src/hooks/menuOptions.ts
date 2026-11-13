import { useQuery, useQueryClient } from '@tanstack/react-query';
import { vendorApi } from '../services/api';
import { useVendorPreview } from '../stores/vendorPreview';
import { useStoreSwitcher } from '../stores/storeSwitcher';
import { getAuthSessionSnapshot, requireAuthSessionSnapshot } from '../stores/authStore';
import type { AuthSessionSnapshot } from '../lib/authSession';
import { MENU_WRITE_KEY, rereadMenuSoon } from './vendorops';
import { useVendorMutation } from './useVendorMutation';

/**
 * [MENU-OPTIONS · owner 11 Nov 2026] The shared option library (GET /vendor/modifier-groups) and the one sender for
 * every option write of the store tools: a library edit, an attach / detach, a group's size / half-and-half rule or a
 * choice's follow-up group. Each write carries MENU_WRITE_KEY (the menu's one re-read waits for it); after it the
 * library is read again and the menu once, later (an edit of a shared group rewrites every item that uses it).
 * Failures are shown by the screen, in the server's words (lib/menuOptionsEditor menuOptionsRefusal), not as a toast.
 */

export const OPTION_LIBRARY_KEY = ['vendor', 'modifier-groups'] as const;

export type LibraryOption = {
  id: string; name: string; price: number; isDefault: boolean; isAvailable: boolean; sortOrder: number;
  followUpGroupId: string | null; externalCode: string | null;
};
export type LibraryGroup = {
  id: string; name: string; isRequired: boolean; minSelect: number; maxSelect: number; sortOrder: number;
  setsPrice: boolean; allowHalves: boolean; halfPricePercent: number; isFollowUp: boolean;
  usedByItemCount: number; usedByItems: Array<{ id: string; name: string }>; options: LibraryOption[];
};

/** The store's library. A sample preview has none (nothing is read).
 *  [REVIEW-MENU-A S4-11] Read for the selected store (its id in the key and on the request). */
export function useOptionLibrary(enabled = true) {
  const preview = useVendorPreview((s) => s.previewType) != null;
  const storeId = useStoreSwitcher((s) => s.selectedStoreId);
  return useQuery({
    queryKey: [...OPTION_LIBRARY_KEY, storeId ?? null],
    queryFn: async () => {
      const r = await vendorApi.modifierGroups(getAuthSessionSnapshot() ?? undefined, storeId);
      return ((r?.data?.data ?? []) as LibraryGroup[]);
    },
    enabled: enabled && !preview,
  });
}

/** [REVIEW-MENU-A S4-11] Who and which store an option write is for: the signed-in account and the store selected when
 *  the tap happened (the write's own guard refuses it if the store changed before it left). */
export type MenuWriteScope = { session: AuthSessionSnapshot; storeId: string | null };
export function menuWriteScope(): MenuWriteScope {
  return { session: requireAuthSessionSnapshot(), storeId: useStoreSwitcher.getState().selectedStoreId };
}

/** One option write: the caller passes the request; the answer is the server's `data`. */
export function useMenuOptionsWrite() {
  const qc = useQueryClient();
  return useVendorMutation({
    mutationKey: MENU_WRITE_KEY,
    meta: { silent: true },
    mutationFn: async (send: () => Promise<any>) => {
      const r = await send();
      return r?.data?.data as any;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: OPTION_LIBRARY_KEY });
      rereadMenuSoon(qc);
    },
  });
}
