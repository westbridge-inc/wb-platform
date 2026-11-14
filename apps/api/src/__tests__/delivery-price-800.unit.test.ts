import { describe, it, expect } from 'vitest';
import type { UserRole } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_DELIVERY_RATES, EXPRESS_DELIVERY_SURCHARGE, calculateDeliveryFee, deliveryFeeFromRates, expressDeliveryFee,
} from '../utils/markup';
import { DEFAULT_TAXI_RATES } from '../modules/country/pricing-config';
import { DEFAULT_COURIER_RATES } from '../modules/courier/courier.service';
import { LEGAL_VERSION } from '../modules/legal/legal.routes';
import { MATERIAL_CHANGES, NON_MATERIAL_CHANGES, acceptanceStatus, materialVersion } from '../modules/legal/reaccept';

// ---------------------------------------------------------------------------
// [DELIVERY-800 · owner ruling 8 Nov 2026] The delivery fee on a food, grocery
// or shop order is priced like a taxi: GY$800 for the first 3 km, then GY$175
// per km (it was GY$500, then GY$100 per km). Express still adds the flat
// GY$1,000 per store; parcels and taxi fares are unchanged.
//
// One home for the numbers (utils/markup.ts DEFAULT_DELIVERY_RATES), the one
// place a figure is written out for customers (the website's Delivery policy)
// held to it, and the wording change shipped under its own legal version,
// MATERIAL because it is a price rise after launch (GUARDRAILS standing rule 1:
// a fresh tick with the in-app notice, never "continued use").
// ---------------------------------------------------------------------------

const REPO = join(__dirname, '..', '..', '..', '..');
const GYD = (n: number) => n.toLocaleString('en-US');

describe('the schedule is the taxi’s: 800 for the first 3 km, then 175 a km', () => {
  it('is the owner’s numbers, and the taxi’s base, included distance and per-km rate', () => {
    expect(DEFAULT_DELIVERY_RATES).toEqual({ baseFee: 800, perKmRate: 175, includedKm: 3, surgeMultiplier: 1 });
    expect([DEFAULT_DELIVERY_RATES.baseFee, DEFAULT_DELIVERY_RATES.includedKm, DEFAULT_DELIVERY_RATES.perKmRate])
      .toEqual([DEFAULT_TAXI_RATES.base, DEFAULT_TAXI_RATES.includedKm, DEFAULT_TAXI_RATES.perKm]);
  });

  it.each([
    // [km, fee]: never below the base; beyond 3 km, 175 a km, a part kilometre pro rata and rounded up to a whole dollar
    [0, 800], [2, 800], [3, 800], [3.46, 881], [4, 975], [5, 1150], [10, 2025], [10.15, 2052],
  ])('%s km costs %s', (km, fee) => {
    expect(deliveryFeeFromRates(km, DEFAULT_DELIVERY_RATES)).toBe(fee);
    expect(calculateDeliveryFee(km)).toBe(fee);
  });

  it('express still adds the flat 1,000 per store: 5 km express is 2,150', () => {
    expect(EXPRESS_DELIVERY_SURCHARGE).toBe(1000);
    expect(expressDeliveryFee(deliveryFeeFromRates(5, DEFAULT_DELIVERY_RATES))).toBe(2150);
  });

  it('parcels and taxi fares are untouched', () => {
    expect([DEFAULT_COURIER_RATES.baseFee, DEFAULT_COURIER_RATES.perKmRate]).toEqual([800, 120]);
    expect(DEFAULT_TAXI_RATES).toEqual({ base: 800, includedKm: 3, perKm: 175, perMin: 0, minimum: 800 });
  });
});

describe('the website’s Delivery policy states the schedule from the one constant', () => {
  const page = readFileSync(join(REPO, 'apps/web/src/app/legal/delivery/page.tsx'), 'utf8').replace(/\s+/g, ' ');

  it('names the code’s numbers, and no longer the old ones', () => {
    const D = DEFAULT_DELIVERY_RATES;
    expect(page).toContain(
      `GYD ${GYD(D.baseFee)} for the first ${D.includedKm} km, then GYD ${GYD(D.perKmRate)} per km; express adds GYD ${GYD(EXPRESS_DELIVERY_SURCHARGE)} to the standard fee, whatever the distance.`,
    );
    expect(page).not.toMatch(/GYD 500 for the first|GYD 100 per km/);
    expect(page).toContain("const UPDATED = '8 November 2026';");
  });
});

describe('LEGAL_VERSION 2026-11-08 for the delivery-price wording: material, so everyone ticks again', () => {
  it('is served, and classed material exactly once, for everyone', () => {
    // [LEGAL-CALLS · owner 9 Nov 2026] served now under 2026-11-09 (in-app calls: material); 2026-11-08 stays material
    expect(LEGAL_VERSION).toBe('2026-11-13'); // [STORE-VAT-EXCLUSIVE] served now under 2026-11-13 (prices before VAT, material for everyone)
    const entry = MATERIAL_CHANGES.filter((c) => c.version === '2026-11-08');
    expect(entry).toHaveLength(1);
    expect(entry[0]!.audience).toBeUndefined();
    expect(NON_MATERIAL_CHANGES.map((c) => c.version)).not.toContain('2026-11-08');
    expect(materialVersion('2026-11-08')).toBe('2026-11-08');
  });

  it('the summary names the new and the old price, and that express is unchanged', () => {
    const words = MATERIAL_CHANGES.find((c) => c.version === '2026-11-08')!.summary.join(' ');
    expect(words).toContain('now costs GY$800 for the first 3 km, then GY$175 per km');
    expect(words).toContain('it was GY$500 for the first 3 km, then GY$100 per km');
    expect(words).toContain(`Express still adds GY$${GYD(EXPRESS_DELIVERY_SURCHARGE)} for each store.`);
    expect(words).toContain('Your cart always shows the fee before you order, and an order already placed keeps its fee.');
    // Facts only: a delivery total is not a taxi fare (the taxi rounds to the nearest 100, airports and classes differ).
    expect(words).not.toMatch(/taxi/i);
  });

  it.each([
    ['a customer', ['CUSTOMER']], ['a rider', ['MOVER', 'CUSTOMER']], ['a store owner', ['VENDOR_OWNER', 'CUSTOMER']],
  ] as const)('%s at 2026-11-06 is asked once, with the delivery summary alone; at 2026-11-08, not', (_who, roles) => {
    const summary = MATERIAL_CHANGES.find((c) => c.version === '2026-11-08')!.summary;
    // [LEGAL-CALLS] Read as served at 2026-11-08 (2026-11-09, in-app calls, is served on top: legal-calls-2026-11-09.unit.test.ts).
    expect(acceptanceStatus({ tosVersion: '2026-11-06', roles: [...roles] as UserRole[] }, '2026-11-08')).toMatchObject({ needsAcceptance: true, summary });
    expect(acceptanceStatus({ tosVersion: '2026-11-08', roles: [...roles] as UserRole[] }, '2026-11-08')).toMatchObject({ needsAcceptance: false, summary: [] });
  });
});
