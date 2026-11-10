import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StorePage from '@/app/(app)/store/[slug]/page';
import type { StorefrontDetail } from '@/lib/api';
import * as api from '@/lib/api';
import * as customer from '@/lib/customer';
import * as auth from '@/lib/auth';
import * as browseServer from '@/lib/browse-server';

// ---------------------------------------------------------------------------
// [RATINGS · owner report 10 Nov 2026] "Other customers can't see the store rating." A store's star
// figure is shown from its 5th rating (rating-math.ts RATING_MIN_DISPLAY — a design rule, unchanged
// here). Below that the website's store page said "No ratings yet" — untrue once a customer HAS
// rated it — while the phone app says "New" and the website's own store list says "New (2)". The
// store page now says what is true: "New", with the count once there is one.
// ---------------------------------------------------------------------------

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), query: '' }));
vi.mock('next/navigation', () => ({ useRouter: () => nav, useSearchParams: () => new URLSearchParams(nav.query), notFound: () => { throw new Error('not found'); } }));

const shop = (rating: Pick<StorefrontDetail, 'displayRating' | 'ratingBucket' | 'ratingCount'>): StorefrontDetail => ({
  id: 'store-shop', slug: 'westbridge-inc', name: 'Westbridge Inc.', description: null,
  vendorType: 'STORE', logoUrl: null, coverImageUrl: null, city: 'Georgetown', region: 'Demerara',
  cuisineTypes: [], tags: [], topRated: false, ...rating,
  isCurrentlyOpen: true, acceptingOrders: true, estimatedPrepTime: 20, minOrderAmount: 0, isFeatured: false,
  addressLine1: 'Main Street', operatingHours: [],
  categories: [{ id: 'cat-1', name: 'Everything', items: [{ id: 'item-1', name: 'Boys vest', description: null,
    basePrice: 1500, imageUrl: null, unit: null, isPopular: false, fulfillment: 'DELIVERY' }] }],
});

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
async function storeLine(store: StorefrontDetail): Promise<string> {
  serve(store);
  const html = renderToString(await StorePage({ params: Promise.resolve({ slug: store.slug }), searchParams: Promise.resolve({}) }));
  const meta = /<p class="[^"]*storeMeta[^"]*">([^<]*)<\/p>/.exec(html);
  if (!meta) throw new Error('the store page drew no store line');
  return meta[1]!.replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
}

beforeEach(() => {
  sessionStorage.clear(); localStorage.clear();
  vi.restoreAllMocks();
});

describe('[RATINGS] the store page says what is true about its ratings', () => {
  it('rated, but under the 5 a star figure needs: "New (2)", never "No ratings yet"', async () => {
    const line = await storeLine(shop({ displayRating: null, ratingBucket: '(2)', ratingCount: 2 }));
    expect(line).toContain('New (2)');
    expect(line).not.toContain('No ratings yet');
  });

  it('nobody has rated it: "No ratings yet"', async () => {
    expect(await storeLine(shop({ displayRating: null, ratingBucket: '(0)', ratingCount: 0 }))).toContain('No ratings yet');
  });

  it('from the 5th rating: the star figure and its count, as before', async () => {
    const line = await storeLine(shop({ displayRating: 4.7, ratingBucket: '(7)', ratingCount: 7 }));
    expect(line).toContain('4.7 (7)');
    expect(line).not.toMatch(/New|No ratings yet/);
  });
});
