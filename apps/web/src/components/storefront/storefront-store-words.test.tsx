import { render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StorePage from '@/app/(app)/store/[slug]/page';
import type { StorefrontDetail } from '@/lib/api';
import * as api from '@/lib/api';
import * as customer from '@/lib/customer';
import * as auth from '@/lib/auth';
import * as browseServer from '@/lib/browse-server';

// ---------------------------------------------------------------------------
// [STORE-WORDS · owner 9 Nov 2026] A clothing shop's page spoke like a kitchen: "20 min prep", the "live
// menu", "Dining in? … your server". The storefront now speaks the store's kind; a restaurant keeps
// every one of its words.
// ---------------------------------------------------------------------------

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), query: '' }));
vi.mock('next/navigation', () => ({ useRouter: () => nav, useSearchParams: () => new URLSearchParams(nav.query), notFound: () => { throw new Error('not found'); } }));

const base = (vendorType: StorefrontDetail['vendorType'], name: string, item: string): StorefrontDetail => ({
  id: `store-${vendorType}`, slug: `store-${vendorType.toLowerCase()}`, name, description: null,
  vendorType, logoUrl: null, coverImageUrl: null, city: 'Georgetown', region: 'Demerara',
  cuisineTypes: [], tags: [], displayRating: null, ratingBucket: 'NEW', ratingCount: 0, topRated: false,
  isCurrentlyOpen: true, acceptingOrders: true, estimatedPrepTime: 20, minOrderAmount: 0, isFeatured: false,
  addressLine1: 'Main Street', operatingHours: [],
  categories: [{ id: 'cat-1', name: 'Everything', items: [{ id: 'item-1', name: item, description: null,
    basePrice: 1500, imageUrl: null, unit: null, isPopular: false, fulfillment: 'DELIVERY' }] }],
});
const SHOP = base('STORE', 'Westbridge Inc.', 'Boys vest');
const RESTAURANT = base('RESTAURANT', 'Garden Kitchen', 'Pumpkin roti');

function serve(store: StorefrontDetail) {
  vi.spyOn(api, 'fetchStorefront').mockResolvedValue(store);
  vi.spyOn(browseServer, 'storeMenuForPage').mockResolvedValue(null);
  vi.spyOn(auth, 'sessionProbe').mockResolvedValue({ ok: false });
  vi.spyOn(customer, 'getPublicStorefront').mockResolvedValue(store);
  vi.spyOn(customer, 'getPublicVendor').mockResolvedValue({ ...store, description: undefined, categories: store.categories.map((category) => ({
    ...category, items: category.items.map((entry) => ({ ...entry, description: undefined, isAvailable: true })),
  })) });
  vi.spyOn(customer, 'getCart').mockRejectedValue(new Error('A guest must not load a cart'));
}
const page = (store: StorefrontDetail, search: Record<string, string> = {}) => StorePage({
  params: Promise.resolve({ slug: store.slug }), searchParams: Promise.resolve(search),
});

beforeEach(() => {
  sessionStorage.clear(); localStorage.clear();
  vi.restoreAllMocks();
});

describe('[STORE-WORDS] the storefront speaks the store\'s kind', () => {
  it('a shop: "Ready in about 20 min", no kitchen words, an in-store QR line', async () => {
    serve(SHOP);
    const element = await page(SHOP, { src: 'qr' });
    const html = renderToString(element);
    expect(html).toContain('Boys vest');
    expect(html).toContain('Ready in about 20 min');
    expect(html).toContain('In the store? Browse what it sells here and order at the counter.');
    expect(html).toContain('Catalogue sections');
    expect(html).not.toMatch(/min prep|Dining in|your server|\bmenu\b/i);
    render(element);
    expect(screen.getByRole('region', { name: 'Catalogue' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dismiss in-store message' })).toBeTruthy();
  });

  it('a restaurant is unchanged: "20 min prep", the menu, and the dining-in line', async () => {
    serve(RESTAURANT);
    const element = await page(RESTAURANT, { src: 'qr' });
    const html = renderToString(element);
    expect(html).toContain('20 min prep');
    expect(html).toContain('Dining in? Browse our menu here and place your order with your server.');
    expect(html).toContain('Menu sections');
    render(element);
    expect(screen.getByRole('region', { name: 'Menu' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dismiss dining-in message' })).toBeTruthy();
  });
});
