import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { categoryReviewTitle, lowStockNoticeWords, storeCoachingLine } from '../modules/notification/store-kind-notice-words';

// [STORE-WORDS sweep · owner 9 Nov 2026] A clothing shop was told its sold-out item "was hidden from your menu", and a
// shop's Standing card coached it about "prep time" and "a dish". A restaurant keeps its words exactly.
const KITCHEN = /\bmenu\b|\bprep\b|kitchen|\bdish\b|cooking/i;
const SRC = join(__dirname, '..');

describe('the sold-out notice a store owner gets', () => {
  const out = { name: 'Boys vest', remaining: 0, kind: 'out' as const };

  it('a restaurant: unchanged', () => {
    expect(lowStockNoticeWords(out, 'RESTAURANT')).toEqual({ title: 'Item sold out', body: 'Boys vest sold out and was hidden from your menu. Restock to bring it back.' });
  });

  it('a shop, a supermarket, a service business or an unknown kind: "your store", never a menu', () => {
    for (const kind of ['STORE', 'SUPERMARKET', 'SERVICE', null, undefined]) {
      const words = lowStockNoticeWords(out, kind);
      expect(words.body, String(kind)).toBe('Boys vest sold out and was hidden from your store. Restock to bring it back.');
      expect(words.body).not.toMatch(KITCHEN);
    }
  });

  it('low stock reads the same for every store', () => {
    expect(lowStockNoticeWords({ name: 'Rice 5 kg', remaining: 3, kind: 'low' }, 'SUPERMARKET')).toEqual({ title: 'Low stock', body: 'Rice 5 kg is down to 3 in stock.' });
  });

  it('every caller passes the store kind', () => {
    const service = readFileSync(join(SRC, 'modules/notification/notification.service.ts'), 'utf8');
    expect(service).toMatch(/\.\.\.lowStockNoticeWords\(ev, vendorType\)/);
    const order = readFileSync(join(SRC, 'modules/order/order.service.ts'), 'utf8');
    expect(order.match(/this\.notifications\.lowStock\(vendorOwner\.userId, ev, order\.vendor\??\.vendorType\)/g)).toHaveLength(2);
    expect(order.match(/notifications\.lowStock\([^)]*\)/g)).toHaveLength(2);
    const routes = readFileSync(join(SRC, 'modules/vendor/vendor.routes.ts'), 'utf8');
    expect(routes).toMatch(/notifications\.lowStock\(vendor\.owner\.userId, alert, vendor\.vendorType\)/);
  });
});

describe('the Standing coaching card', () => {
  const PREP = 'Keep your prep time honest in the app — customers forgive a long quote, not a broken one.';
  const DISH = 'Update photos and descriptions when a dish changes — the listing is a promise.';

  it('a restaurant: its kitchen lines unchanged', () => {
    expect(storeCoachingLine('long-wait', PREP, 'RESTAURANT')).toBe(PREP);
    expect(storeCoachingLine('not-as-described', DISH, 'RESTAURANT')).toBe(DISH);
  });

  it('any other store: no prep time, no dish', () => {
    for (const kind of ['STORE', 'SUPERMARKET', null]) {
      expect(storeCoachingLine('long-wait', PREP, kind)).toBe('Keep your ready time honest in the app — customers forgive a long quote, not a broken one.');
      expect(storeCoachingLine('not-as-described', DISH, kind)).toBe('Update photos and descriptions when an item changes — the listing is a promise.');
      expect(storeCoachingLine('wrong-item', 'Read the order line by line as you pack.', kind)).toBe('Read the order line by line as you pack.');
      expect(storeCoachingLine('no-line', undefined, kind)).toBeUndefined();
    }
  });

  it('the Standing view words a store\'s card through its kind', () => {
    const standing = readFileSync(join(SRC, 'modules/rating/rating-standing.ts'), 'utf8');
    expect(standing).toMatch(/role === 'VENDOR' \? storeCoachingLine\(t\.tag, COACHING\[role\]\[t\.tag\], vendorType\)/);
    expect(standing).toMatch(/const coaching = coachingFor\(role, standing, topNegative, vendorType\);/);
  });
});

describe('the "review your categories" notice', () => {
  it('"Your menu" only for a restaurant, and the backfill hands the kind to the notice', () => {
    expect(categoryReviewTitle('RESTAURANT')).toBe('Your menu just got easier to find');
    for (const kind of ['STORE', 'SUPERMARKET', 'SERVICE', null]) expect(categoryReviewTitle(kind)).toBe('Your store just got easier to find');
    expect(readFileSync(join(SRC, 'modules/discovery/backfill.ts'), 'utf8')).toMatch(/opts\.notify\(vendor\.owner\.userId, vendor\.vendorType\)/);
    expect(readFileSync(join(SRC, 'jobs/queue.ts'), 'utf8')).toMatch(/title: categoryReviewTitle\(vendorType\),/);
  });
});
