import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { DEFAULT_DELIVERY_RATES, calculateDeliveryFee, deliveryFeeFromRates, expressDeliveryFee } from '../utils/markup';
import { canonicalBillableKm } from '../utils/billable-distance';
import { planVendorGroup } from '../modules/order/cart-plans';
import { validatePricingConfig } from '../modules/country/pricing-config';

// ---------------------------------------------------------------------------
// [DELIVERY-ROUND · 8 Nov 2026] The delivery fee is exact whole-dollar maths.
//
// The published price (the website's Delivery policy): GYD 800 for the first
// 3 km, then GYD 175 per km — a part kilometre pro rata, the total rounded UP
// to a whole dollar (GYD has no cents). The fee used to be computed in binary
// floating point and then rounded up, so a distance whose true fee is a whole
// number could come out a hair above it and round up a whole dollar:
//   8.88 km: 800 + 5.88 × 175 = 1,829 exactly; the float gave 1829.0000000000002 → 1,830.
// Checkout prices the canonical distance (0.01 km), and inside 50 km 62 of
// those distances were charged GY$1 over the published price.
//
// The oracle below is integer-only: a canonical distance is a whole number of
// hundredths of a km, so the published fee is 800 + ceil(hundredths × 175 / 100).
// ---------------------------------------------------------------------------

const D = DEFAULT_DELIVERY_RATES;

/** The published fee for a distance of `h` hundredths of a km, in integers only. */
function publishedFee(h: number): number {
  const over = Math.max(0, h - D.includedKm * 100); // hundredths of a km past the included 3 km
  return D.baseFee + Math.ceil((over * D.perKmRate) / 100); // over × 175 is an integer; one integer division
}

const REPO = join(__dirname, '..', '..', '..', '..');

describe('the delivery fee equals the published price at every distance', () => {
  it.each([
    // [km, fee]: inside the included 3 km, exact km boundaries, part kilometres rounded up
    [0, 800], [0.01, 800], [2.99, 800], [3, 800], [3.01, 802], [3.46, 881], [4, 975], [5, 1150],
    [7.16, 1528], [10, 2025], [10.15, 2052], [25, 4650], [100, 17775],
    // the float traps: each fee is a whole number, and the float maths charged one more
    [8.88, 1829], [8.96, 1843], [9.8, 1990], [9.88, 2004], [9.96, 2018],
    [16.6, 3180], [16.76, 3208], [20.6, 3880], [32.2, 5910], [34.52, 6316],
  ])('%s km costs GY$%s', (km, fee) => {
    expect(calculateDeliveryFee(km)).toBe(fee);
    expect(deliveryFeeFromRates(km, D)).toBe(fee);
    expect(publishedFee(Math.round(km * 100))).toBe(fee); // the oracle agrees with the hand-worked table
  });

  it('every canonical distance from 0 to 150 km (0.01 km steps) is priced exactly', () => {
    const wrong: string[] = [];
    for (let h = 0; h <= 15_000; h++) {
      const km = canonicalBillableKm(h / 100);
      const fee = deliveryFeeFromRates(km, D);
      if (fee !== publishedFee(h)) wrong.push(`${km} km: ${fee} (published ${publishedFee(h)})`);
    }
    expect(wrong).toEqual([]);
  });

  it('a distance in whole metres is priced exactly (checkout itself freezes 0.01 km)', () => {
    // calculateDeliveryFee counts whole metres: whatever the float, the fee is
    // the published price of the distance to the metre. Checkout and every
    // display price canonicalBillableKm (0.01 km) first, which is exact here.
    for (let m = 3000; m <= 20_000; m += 7) {
      const km = m / 1000;
      const exact = D.baseFee + Math.ceil(((m - D.includedKm * 1000) * D.perKmRate) / 1000);
      expect(calculateDeliveryFee(km), `${km} km`).toBe(exact);
    }
  });

  it('always a whole number of dollars, never below the base, never down from a shorter trip', () => {
    let previous = 0;
    for (let h = 0; h <= 5_000; h++) {
      const fee = calculateDeliveryFee(h / 100);
      expect(Number.isInteger(fee)).toBe(true);
      expect(fee).toBeGreaterThanOrEqual(D.baseFee);
      expect(fee).toBeGreaterThanOrEqual(previous);
      previous = fee;
    }
  });
});

describe('a market’s own schedule (surge, other rates) is exact too', () => {
  it.each([
    // [km, base, perKm, includedKm, surge, fee]
    [5, 500, 200, 2, 1.5, 1650], //   (500 + 3 × 200) × 1.5 = 1,650
    [3, 500, 200, 2, 1.3, 910], //    700 × 1.3 = 910
    [2, 501, 200, 2, 1.5, 752], //    501 × 1.5 = 751.5 → 752
    [6, 1000, 500, 3, 1, 2500],
    [8.88, 800, 175, 3, 1.1, 2012], // 1,829 × 1.1 = 2,011.9 → 2,012
    [4.1, 800, 175, 3, 1.2, 1191], //  992.5 × 1.2 = 1,191 exactly: never rounded up to 1,192
    [3.7, 800, 175, 2.5, 1, 1010], //  a fractional included distance: 800 + 1.2 × 175 = 1,010
  ])('%s km at %s + %s/km over %s km, surge %s → GY$%s', (km, base, perKm, included, surge, fee) => {
    expect(calculateDeliveryFee(km, base, perKm, included, surge)).toBe(fee);
    expect(deliveryFeeFromRates(km, { baseFee: base, perKmRate: perKm, includedKm: included, surgeMultiplier: surge })).toBe(fee);
  });

  it('keeps the floor and the negative-rate guard [owner #18]', () => {
    expect(calculateDeliveryFee(10, 800, -175, 3, 1)).toBe(800);
    expect(calculateDeliveryFee(10, 800, 175, 3, 0.5)).toBe(1013); // 2,025 × 0.5 = 1,012.5 → 1,013
    expect(calculateDeliveryFee(1, 800, 175, 3, 0.5)).toBe(800); //    never below the base
    expect(calculateDeliveryFee(-4)).toBe(800);
  });
});

describe('[N1] a market’s surge is stored with at most 6 decimals, so the millionths maths is exact', () => {
  const surge = (surgeMultiplier: number) => validatePricingConfig('DELIVERY_RATES', { surgeMultiplier }).status;

  it.each([1, 1.3, 1.25, 0.5, 10, 1.234567, 2.000001])('surge %s is accepted', (m) => {
    expect(surge(m)).toBe('VALID');
  });

  it.each([1.2345678, 4 / 3, 1.0000001])('surge %s (more than 6 decimals) is refused', (m) => {
    expect(surge(m)).toBe('INVALID');
  });

  it('every 6-decimal surge the schema accepts prices exactly (sampled)', () => {
    // 1,829 x surge rounded up, from an integer oracle in millionths.
    for (let micro = 500_000; micro <= 10_000_000; micro += 7_919) {
      const m = micro / 1_000_000;
      expect(surge(m), `${m}`).toBe('VALID');
      const want = Math.max(800, Number((1829n * BigInt(micro) + 999_999n) / 1_000_000n));
      expect(calculateDeliveryFee(8.88, 800, 175, 3, m), `${m}`).toBe(want);
    }
  });
});

describe('[N4] the store card and storefront header price the canonical distance, like the cart', () => {
  // The DB suite (delivery-fee-display-parity) proves card == header == planner on
  // mounted routes; this pins the source so the raw estimate cannot creep back.
  const src = readFileSync(join(REPO, 'apps/api/src/modules/user/customer.routes.ts'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('every deliveryFeeFromRates call in customer.routes prices canonicalBillableKm (or the fixed 3 km preview)', () => {
    const calls = [...code.matchAll(/deliveryFeeFromRates\(\s*([^,]+),/g)].map((m) => m[1]!.trim());
    expect(calls.length).toBeGreaterThanOrEqual(3); // the card, the header, the free-delivery preview
    for (const arg of calls) expect(arg, arg).toMatch(/^(canonicalBillableKm\(.+\)|3)$/);
  });
});

describe('the cart quote and the checkout charge are the same exact number', () => {
  const vendor = { id: 'v1', name: 'Near', latitude: 6.8015, longitude: -58.156, minOrderAmount: '0' };

  it.each([[8.8799999], [8.88], [9.8000001], [16.6]])('a route of %s km plans the published fee', async (routed) => {
    const plan = await planVendorGroup({
      vendor, lines: [], fulfillment: 'DELIVERY', destination: { lat: 6.81, lng: -58.17 },
      deliveryRates: D, express: false, routeKm: async () => ({ km: routed, source: 'osrm' as const }),
    });
    const h = Math.round(routed * 100);
    expect(plan.distanceKm).toBe(h / 100);
    expect(plan.standardDeliveryFee).toBe(publishedFee(h));
    expect(plan.deliveryFee).toBe(publishedFee(h));
    const fast = await planVendorGroup({
      vendor, lines: [], fulfillment: 'DELIVERY', destination: { lat: 6.81, lng: -58.17 },
      deliveryRates: D, express: true, routeKm: async () => ({ km: routed, source: 'osrm' as const }),
    });
    expect(fast.deliveryFee).toBe(expressDeliveryFee(publishedFee(h)));
  });
});

describe('packages/utils prices delivery the same exact way', () => {
  function loadPackage(path: string): Record<string, unknown> {
    const js = ts.transpileModule(readFileSync(join(REPO, path), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} as Record<string, unknown> };
    runInNewContext(js, { module, exports: module.exports });
    return module.exports;
  }

  it('every canonical distance from 0 to 50 km', () => {
    const utils = loadPackage('packages/utils/src/pricing.ts') as Record<'calculateDeliveryFee', (o: { distanceKm: number }) => number>;
    const wrong: string[] = [];
    for (let h = 0; h <= 5_000; h++) {
      const fee = utils.calculateDeliveryFee({ distanceKm: h / 100 });
      if (fee !== publishedFee(h)) wrong.push(`${h / 100} km: ${fee}`);
    }
    expect(wrong).toEqual([]);
  });
});
