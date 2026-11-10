/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [OWNNAME-FIT · COORD ruling 7 Nov 2026, Business Names (Registration) Act Cap. 90:05 s.3] The REAL store checklist
// offers "No business name? Trade under your own name" only when the server says the selected store's name passes its
// own-name test (GET /verification/status `ownNameFits`, per store). It used to be offered to every store missing a
// business registration, e.g. a store named "Westbridge Inc.", which the signing route refuses anyway. An older server
// (no field) offers nothing. The "sign" and "drop" cards are unchanged. The own-name card is a stand-in that shows
// its mode.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));
vi.mock('react-native', async () => {
  const R = await import('react');
  const View = ({ children }: any) => R.createElement('div', null, children);
  const Pressable = ({ children, onPress, accessibilityLabel, testID }: any) =>
    R.createElement('button', { type: 'button', 'aria-label': accessibilityLabel, 'data-testid': testID, onClick: onPress },
      typeof children === 'function' ? children({ pressed: false }) : children);
  return { View, Pressable };
});
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('../../kit', async () => {
  const R = await import('react');
  return {
    BrandCheckbox: () => null,
    EmptyState: ({ title }: { title: string }) => R.createElement('p', null, title),
    Spinner: () => R.createElement('p', null, 'loading'),
    T: ({ children }: any) => R.createElement('span', null, children),
  };
});
vi.mock('./OwnNameCard', async () => {
  const R = await import('react');
  return { OwnNameCard: ({ mode }: { mode: string }) => R.createElement('div', { 'data-own-name': mode }) };
});
vi.mock('./FoodHandlersCard', () => ({ FoodHandlersCard: () => null }));
vi.mock('./StoreWeeklyFeeCard', () => ({ StoreWeeklyFeeCard: () => null }));
vi.mock('./AuthorityLetterEsignCard', () => ({ AuthorityLetterEsignCard: () => null }));
vi.mock('./DocumentUploadCard', async () => {
  const R = await import('react');
  return { DocumentUploadCard: ({ docType }: { docType: string }) => R.createElement('div', { 'data-doc': docType }) };
});

import { DocumentChecklist } from './DocumentChecklist';

const STORE = 'store-1';
const statusWith = (extra: Record<string, unknown> = {}, checklist = ['owner_national_id', 'business_registration', 'storefront_photo']) =>
  ({ checklist, optional: [], documents: [], ...extra });

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
const mount = async (status: unknown, storeId: string | null = STORE) => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(React.createElement(DocumentChecklist, { role: 'STORE', status, storeName: 'R. Persaud', storeId })));
};
const modes = () => [...host!.querySelectorAll('[data-own-name]')].map((n) => n.getAttribute('data-own-name'));
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); host = undefined; root = undefined;
});

describe('[OWNNAME-FIT] the phone offers the own-name route only when the store\'s name is the owner\'s own name', () => {
  it('offered when the server says this store\'s name fits', async () => {
    await mount(statusWith({ ownNameFits: { [STORE]: true } }));
    expect(modes()).toEqual(['offer']);
  });

  it('not offered for a name that does not fit (e.g. "Westbridge Inc."), for another store\'s answer, or with no store id', async () => {
    await mount(statusWith({ ownNameFits: { [STORE]: false } }));
    expect(modes()).toEqual([]);
    await act(async () => root!.unmount()); host!.remove();
    await mount(statusWith({ ownNameFits: { 'store-2': true } }));
    expect(modes()).toEqual([]);
    await act(async () => root!.unmount()); host!.remove();
    await mount(statusWith({ ownNameFits: { [STORE]: true } }), null);
    expect(modes()).toEqual([]);
  });

  it('an older server that sends no answer: no offer', async () => {
    await mount(statusWith());
    expect(modes()).toEqual([]);
  });

  it('a registration already approved: no offer even when the name fits', async () => {
    await mount(statusWith({
      ownNameFits: { [STORE]: true },
      documents: [{ id: 'd1', docType: 'business_registration', status: 'APPROVED', expiresAt: null, createdAt: '2026-11-01T00:00:00.000Z' }],
    }));
    expect(modes()).toEqual([]);
  });

  it('the "drop" card is unchanged: an own-name store can go back to a registered name, whatever ownNameFits says', async () => {
    await mount(statusWith({}, ['owner_national_id', 'own_name_declaration', 'storefront_photo']));
    expect(modes()).toContain('drop');
    expect(modes()).not.toContain('offer');
  });
});
