import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { cachedOrderRow, itemPreviewOf, newestCachedCart, readItemPreview, readStorePreview, storePreviewOf } from './doorPreview';

// [APP-SPEED A] What a door may draw before its own read: only facts the server already sent.

describe('a card’s own facts, handed to the next screen', () => {
  it('a store card: its name and photo keys, nothing else (no rating, no open/closed, no money)', () => {
    const row = { id: 's', name: 'Store a', coverImageUrl: 'items/a/cover', logoUrl: '', isCurrentlyOpen: true, displayRating: 4.8, deliveryFee: 500 };
    expect(storePreviewOf(row)).toEqual({ name: 'Store a', coverImageUrl: 'items/a/cover', logoUrl: null });
    expect(storePreviewOf({ name: '  ' })).toBeUndefined();
    expect(storePreviewOf(null)).toBeUndefined();
  });

  it('[STORE-WORDS sweep · review note 1] a card that names its store kind passes it on, so a restaurant opens "Loading the menu"', () => {
    expect(storePreviewOf({ name: 'Store a', vendorType: 'RESTAURANT' })).toEqual({ name: 'Store a', coverImageUrl: null, logoUrl: null, vendorType: 'RESTAURANT' });
    expect(readStorePreview({ name: 'Store a', vendorType: 'STORE' })?.vendorType).toBe('STORE');
    expect(readStorePreview({ name: 'Store a', vendorType: 4 })).toEqual({ name: 'Store a', coverImageUrl: null, logoUrl: null });
  });

  it('a dish card: its name and photo key, never its price', () => {
    expect(itemPreviewOf({ id: 'i', name: 'Curry chicken', imageUrl: 'items/a/curry', price: 1000 })).toEqual({ name: 'Curry chicken', imageUrl: 'items/a/curry' });
  });

  it('a route param is read only in the shape a card writes (a link or an older caller passes none)', () => {
    expect(readStorePreview(undefined)).toBeNull();
    expect(readStorePreview('Store a')).toBeNull();
    expect(readStorePreview({ name: 7 })).toBeNull();
    expect(readStorePreview({ name: 'Store a', coverImageUrl: 3 })).toEqual({ name: 'Store a', coverImageUrl: null, logoUrl: null });
    expect(readItemPreview({ name: 'Curry chicken' })).toEqual({ name: 'Curry chicken', imageUrl: null });
    expect(readItemPreview([])).toBeNull();
  });
});

describe('an order already in memory', () => {
  const row = (name: string) => ({ id: 'o1', orderNumber: 'SW-1', vendor: { name } });

  it('found in the live list, the history pages, or Home’s live card; the newest copy wins', () => {
    const qc = new QueryClient();
    qc.setQueryData(['customer', 'orders', 'live'], { items: [row('live')], total: 1 }, { updatedAt: 1_000 });
    qc.setQueryData(['customer', 'orders', 'infinite', 'history'], { pages: [{ items: [row('history')] }], pageParams: [1] }, { updatedAt: 3_000 });
    qc.setQueryData(['customer', 'home', 1, 2], { activeOrder: row('home') }, { updatedAt: 2_000 });
    expect(cachedOrderRow<any>(qc, 'o1')?.vendor.name).toBe('history');
    expect(cachedOrderRow(qc, 'other')).toBeUndefined();
    expect(cachedOrderRow(qc, '')).toBeUndefined();
  });

  it('never from a list that failed or is waiting on its own re-read', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['customer', 'orders', 'live'], { items: [row('live')], total: 1 });
    await qc.invalidateQueries({ queryKey: ['customer', 'orders'], refetchType: 'none' });
    expect(cachedOrderRow(qc, 'o1')).toBeUndefined();
  });

  it('never from another family that happens to hold the same id', () => {
    const qc = new QueryClient();
    qc.setQueryData(['vendor', 'orders'], { items: [row('vendor side')] });
    qc.setQueryData(['customer', 'order', 'o1', 'x'], row('detail'));
    expect(cachedOrderRow(qc, 'o1')).toBeUndefined();
  });
});

describe('a cart quote already in memory', () => {
  it('the newest non-empty quote of the cart; never an empty cart or a quote waiting on its re-read', async () => {
    const qc = new QueryClient();
    expect(newestCachedCart(qc)).toBeUndefined();
    qc.setQueryData(['customer', 'cart', null, null, null], { items: [{ id: 'a' }] }, { updatedAt: 1_000 });
    qc.setQueryData(['customer', 'cart', 1, 2, {}], { items: [{ id: 'b' }] }, { updatedAt: 2_000 });
    qc.setQueryData(['customer', 'cart', 3, 4, {}], { items: [] }, { updatedAt: 3_000 });
    qc.setQueryData(['customer', 'cart', 5, 6, {}], null, { updatedAt: 4_000 });
    expect(newestCachedCart<any>(qc)?.items[0].id).toBe('b');
    await qc.invalidateQueries({ queryKey: ['customer', 'cart', 1, 2], refetchType: 'none' });
    expect(newestCachedCart<any>(qc)?.items[0].id).toBe('a');
  });
});
