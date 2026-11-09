import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockApi, renderWithQuery, stubAudioContext, type ApiRequest } from '@/test/test-utils';
import { wireVendorOrder } from '@/test/vendor-wire-fixtures';
import { normalizeVendorOrder, type Store, type VendorOrder } from '@/lib/vendor-api';
import { ApiRequestError } from '@/lib/auth';
import { promisedTimeName, tooBusyReason, workingOrderWord } from './store-kind-words';
import { ORDER_REJECT_REASONS, rejectReasonsFor } from './reject-reasons';
import { prepTimeLine } from './vendor-order-view';
import { ITEM_GONE_WORDS, itemGoneWords, refusalWords } from './menu-api';
import { kitchenCapacityLine, KitchenCapacityCard } from '@/app/dashboard/settings/kitchen-capacity-card';
import NewOrderTakeover from '@/components/NewOrderTakeover';
import BranchMenuCopy from '@/components/branch-menu-copy';
import StoreQrPage from '@/app/dashboard/qr/page';

// ---------------------------------------------------------------------------
// [STORE-WORDS sweep · owner 9 Nov 2026] A clothing shop read a kitchen's words on its own store console:
// "Kitchen is too busy" (which its customer is then shown), "20 min prep", "Quoted prep time", "cooking",
// "Copy the menu", "your live web menu". The console now takes them from the store's kind (one word list,
// lib/store-kind-words.ts, the app's file byte for byte; the items word from lib/catalogue-name.ts).
// A restaurant keeps every word exactly.
// ---------------------------------------------------------------------------

const KITCHEN = /\bmenu\b|\bprep\b|kitchen|cooking/i;

describe('[STORE-WORDS sweep] the order words', () => {
  it('a restaurant keeps its kitchen words exactly; any other store gets counter words', () => {
    expect([tooBusyReason('RESTAURANT'), promisedTimeName('RESTAURANT'), workingOrderWord('RESTAURANT')]).toEqual(['Kitchen is too busy', 'prep time', 'cooking']);
    for (const kind of ['STORE', 'SUPERMARKET', 'SERVICE', undefined]) {
      expect([tooBusyReason(kind), promisedTimeName(kind), workingOrderWord(kind)]).toEqual(['Too busy right now', 'ready time', 'being prepared']);
    }
  });

  it('reject reasons: a restaurant unchanged, a shop never blames a kitchen, a booking keeps its own', () => {
    expect(rejectReasonsFor('DELIVERY', 'RESTAURANT')).toEqual(ORDER_REJECT_REASONS);
    expect(rejectReasonsFor('PICKUP', 'STORE')).toEqual(['Out of stock', 'Too busy right now', 'Closing soon']);
    expect(rejectReasonsFor('DELIVERY', undefined).join(' ')).not.toMatch(KITCHEN);
    expect(rejectReasonsFor('APPOINTMENT', 'SERVICE').join(' ')).not.toMatch(KITCHEN);
  });

  it('the quoted time line: "prep time" only for a restaurant', () => {
    const order = (vendorType?: string) => ({ ...normalizeVendorOrder(wireVendorOrder({ estimatedPrepTime: 20 })), vendor: vendorType ? { vendorType } : null }) as VendorOrder;
    expect(prepTimeLine(order('RESTAURANT'))).toBe('Quoted prep time: 20 min');
    expect(prepTimeLine(order('STORE'))).toBe('Quoted ready time: 20 min');
    expect(prepTimeLine(order())).toBe('Quoted ready time: 20 min');
  });

  it('"How many orders at once": "cooking" only for a restaurant', () => {
    expect(kitchenCapacityLine(3, 'RESTAURANT')).toContain('(new, cooking or ready)');
    expect(kitchenCapacityLine(3, 'STORE')).toContain('(new, being prepared or ready)');
    expect(kitchenCapacityLine(3, 'STORE')).not.toMatch(KITCHEN);
  });

  it('an item deleted on another device: the store\'s own word for its items', () => {
    expect(itemGoneWords('RESTAURANT')).toBe(ITEM_GONE_WORDS);
    expect(itemGoneWords('STORE')).toBe('This section or item was removed on another phone. Go back and open the catalogue again.');
    const gone = new ApiRequestError('Category with id x not found', 404, 'NOT_FOUND');
    expect(refusalWords(gone, 'SERVICE')).toBe('This section or item was removed on another phone. Go back and open the services again.');
    expect(refusalWords(gone, 'RESTAURANT')).toBe(ITEM_GONE_WORDS);
  });
});

describe('[STORE-WORDS sweep] the store console screens a shop sees', () => {
  beforeEach(async () => {
    stubAudioContext();
    (await import('@/lib/auth')).setSelectedStore('store-1');
  });

  it('the new-order popup: a shop picks a ready time and rejects without blaming a kitchen', async () => {
    const { rerender, user } = renderWithQuery(<NewOrderTakeover orders={[]} />);
    const shopOrder = wireVendorOrder({ vendor: { id: 'store-1', name: 'Westbridge Inc.', vendorType: 'STORE', selfDeliveryEnabled: false } });
    rerender(<NewOrderTakeover orders={[normalizeVendorOrder(shopOrder)]} />);
    await screen.findByText('NEW ORDER');
    const times = [...screen.getByRole('combobox', { name: 'Preparation time' }).querySelectorAll('option')].map((o) => o.textContent);
    expect(times).toContain('Ready in about 20 min');
    expect(times.join(' ')).not.toMatch(KITCHEN);
    await user.click(screen.getByRole('button', { name: 'Reject — tell us why' }));
    expect(screen.getByRole('button', { name: 'Too busy right now' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Kitchen is too busy' })).toBeNull();
  });

  it('the new-order popup: a restaurant keeps "20 min prep" and "Kitchen is too busy"', async () => {
    const { rerender, user } = renderWithQuery(<NewOrderTakeover orders={[]} />);
    rerender(<NewOrderTakeover orders={[normalizeVendorOrder(wireVendorOrder())]} />);
    await screen.findByText('NEW ORDER');
    const times = [...screen.getByRole('combobox', { name: 'Preparation time' }).querySelectorAll('option')].map((o) => o.textContent);
    expect(times).toContain('20 min prep');
    await user.click(screen.getByRole('button', { name: 'Reject — tell us why' }));
    expect(screen.getByRole('button', { name: 'Kitchen is too busy' })).toBeTruthy();
  });

  it('[REVIEW F3] an order from an older API that does not name its kind is worded by the selected store\'s kind', async () => {
    for (const [kind, busy, time] of [['STORE', 'Too busy right now', 'Ready in about 20 min'], ['RESTAURANT', 'Kitchen is too busy', '20 min prep']] as const) {
      mockApi(() => ({ status: 404, body: { success: false } }));
      // The console shell has already read the stores; the popup reads only that copy.
      const { rerender, user, unmount, queryClient } = renderWithQuery(<NewOrderTakeover orders={[]} />);
      queryClient.setQueryData(['stores'], { stores: [{ id: 'store-1', name: 'Store', vendorType: kind, isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true }], selectedId: 'store-1', myRole: 'OWNER' });
      const noKind = wireVendorOrder({ vendor: { id: 'store-1', name: 'Store', selfDeliveryEnabled: false } });
      rerender(<NewOrderTakeover orders={[normalizeVendorOrder(noKind)]} />);
      await screen.findByText('NEW ORDER');
      await screen.findByRole('option', { name: time });
      await user.click(screen.getByRole('button', { name: 'Reject — tell us why' }));
      expect(screen.getByRole('button', { name: busy })).toBeTruthy();
      unmount();
    }
  });

  it('"How many orders at once" on a shop\'s settings never says "cooking"', async () => {
    mockApi((r: ApiRequest) => {
      if (r.url.pathname === '/api/v1/vendor/profile') return { body: { success: true, data: { myRole: 'OWNER', vendors: [{ id: 'store-1', vendorType: 'STORE', maxConcurrentOrders: 4 }] } } };
      return { status: 404, body: { success: false } };
    });
    renderWithQuery(<KitchenCapacityCard storeId="store-1" />);
    expect(await screen.findByText(/Up to 4 orders at a time \(new, being prepared or ready\)/)).toBeTruthy();
    expect(screen.queryByText(/cooking/)).toBeNull();
  });

  it('copying between a shop\'s branches copies its products, never "the menu"', async () => {
    mockApi(() => ({ status: 404, body: { success: false } }));
    const shops = [
      { id: 'a', name: 'Shop A', vendorType: 'STORE', isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true, status: 'ACTIVE', awaitingApproval: false },
      { id: 'b', name: 'Shop B', vendorType: 'STORE', isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true, status: 'ACTIVE', awaitingApproval: false },
    ] as Store[];
    renderWithQuery(<BranchMenuCopy storeId="a" stores={shops} onCopied={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Copy the products from another branch' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy Shop B’s products here' })).toBeTruthy();
    expect(document.body.textContent ?? '').not.toMatch(KITCHEN);
  });

  it('a shop\'s QR page opens its store on the web, never a "web menu"', async () => {
    const SHORT = 'https://swiftgy.test/s/abcdfghjkm';
    mockApi((r: ApiRequest) => {
      const path = r.url.pathname.replace('/api/v1', '');
      if (path === '/vendor/stores') return { body: { success: true, data: { stores: [{ id: 'store-1', name: 'Westbridge Inc.', vendorType: 'STORE', isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true }], selectedId: 'store-1', myRole: 'OWNER' } } };
      if (path === '/vendor/qr') return { body: { success: true, data: { deepLink: SHORT, shortUrl: SHORT, shortCode: 'ABCDFGHJKM', canonicalUrl: 'https://swiftgy.test/store/westbridge', version: 1, status: 'ACTIVE', graceDays: 30, svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', vendorName: 'Westbridge Inc.' } } };
      if (path === '/public/qr/ABCDFGHJKM') return { body: { success: true, data: { verdict: 'WEB_RENDER', vendorId: 'store-1', slug: null } } };
      return { status: 404, body: { success: false } };
    });
    renderWithQuery(<StoreQrPage />);
    expect(await screen.findByText('Customers scan this to open your store on the web — no app install')).toBeTruthy();
    expect(screen.getAllByText('Open web store').length).toBeGreaterThan(0);
    expect(screen.queryByText(/web menu/)).toBeNull();
  });
});

// The rest of the store console a shop sees: every text literal is read; a kitchen word may stay only where the screen
// has already asked whether the store is a restaurant (each one the exact words a restaurant read before).
describe('[STORE-WORDS sweep] census: no unguarded kitchen word on the store console', () => {
  const SRC = join(__dirname, '..');
  const literals = (source: string): string[] => {
    const out: string[] = [];
    for (const line of source.split('\n')) {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*')) continue;
      for (const m of line.matchAll(/`([^`\n]*)`/g)) out.push((m[1] ?? '').replace(/\$\{[^}]*\}/g, '…'));
      for (const m of line.replace(/`[^`\n]*`/g, ' ').replace(/([>}])([^<>{}\n]+)</g, (_all, open: string, text: string) => `${open}'${text}'<`).matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)) {
        out.push(m[1] ?? m[2] ?? '');
      }
    }
    return out;
  };
  /** Not words a person reads: ids, query keys, import paths, route names. */
  const CODE = /^(menu-[a-z-]+|kitchen|menu|Menu|@\/.*|\.\.?\/.*|kitchen-capacity-title)$/;
  const SCREENS: Record<string, string[]> = {
    'components/orders-home.tsx': ['Menu & inventory'],
    'components/orders-home-guides.tsx': [],
    'app/dashboard/inventory/page.tsx': [],
    'app/dashboard/inventory/menu-tools.tsx': [],
    'app/dashboard/orders/order-detail.tsx': [],
    'components/NewOrderTakeover.tsx': [],
    'components/branch-menu-copy.tsx': [],
    'app/dashboard/settings/kitchen-capacity-card.tsx': [],
    'lib/vendor-order-view.ts': [],
  };
  it('the one allowed kitchen word sits behind a restaurant check', () => {
    expect(readFileSync(join(SRC, 'components/orders-home.tsx'), 'utf8')).toMatch(/label=\{catalogue === 'Menu' \? 'Menu & inventory' : catalogue\}/);
  });
  for (const [path, allowed] of Object.entries(SCREENS)) {
    it(path, () => {
      const found = literals(readFileSync(join(SRC, path), 'utf8')).filter((s) => KITCHEN.test(s) && !CODE.test(s.trim()));
      expect([...new Set(found)].sort()).toEqual([...allowed].sort());
    });
  }
});
