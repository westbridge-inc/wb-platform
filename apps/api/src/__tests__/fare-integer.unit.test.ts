import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { DEFAULT_COURIER_RATES, estimateCourierFee, type CourierRates, type DeliverySpeed, type PackageSize } from '../modules/courier/courier.service';
import { applyClassMultiplier, formulaFare } from '../modules/rides/fare.service';
import { DEFAULT_CLASS_RATES, DEFAULT_TAXI_RATES, type TaxiRates } from '../modules/country/pricing-config';
import { calculateCourierFee, calculateTaxiFare } from '../utils/markup';
import { canonicalBillableKm } from '../utils/billable-distance';

// ---------------------------------------------------------------------------
// [FARE-INTEGER · 8 Nov 2026] Parcel fees and taxi fares are exact integer
// maths, like the delivery fee (#2416).
//
// The published prices (unchanged):
//   Parcel  (base + km × per-km + the size surcharge) × the speed, to the
//           nearest dollar (a half rounds up). No included distance; a part
//           kilometre pro rata. Georgetown: 800 + 120/km.
//   Taxi    base + per-km past the included km (+ per-minute), to the nearest
//           100 (a half rounds up), never under the minimum; a ride class is
//           the Economy fare × its multiplier, to the nearest 100. Georgetown:
//           800 for the first 3 km, then 175/km (295/km to or from an airport
//           zone), Comfort ×1.35, Group ×2.5.
//
// They were computed in binary floating point and then rounded. A true price
// that sits exactly on a rounding edge could land a hair to the wrong side:
//   parcel, per-km 175, RUSH: 16.15 km → (800 + 2,826.25) × 2 = 7,252.5 → 7,253,
//          but the float said 7,252.4999… and charged 7,252;
//   taxi, a zone per-km of 250: 129.2 km → 800 + 126.2 × 250 = 32,350 → 32,400,
//          but the float said 32,349.99… and charged 32,300;
//   a class ×0.57 on 5,000 → 2,850 → 2,900, the float charged 2,800;
//   the round-up helpers (markup.calculateCourierFee, calculateTaxiFare and the
//   packages/utils copies, no live caller) were GY$1 over, as delivery was.
// Georgetown's rates today never land on such an edge (every sweep below at the
// live rates was already exact), so no live price moves; any rate the admin
// pricing screen accepts (whole-dollar money, multipliers 0.5–10, whole zone
// per-km) now prices exactly as published. The quote and the booking call the
// same function, so the shown price stays the charged price.
//
// Every oracle here is integer-only (BigInt): a canonical distance is a whole
// number of hundredths of a km, money whole dollars, multipliers millionths.
// ---------------------------------------------------------------------------

const B = BigInt;
const millionths = (m: number) => B(Math.round(m * 1_000_000));
/** round(a / b) with a half going up, for a ≥ 0 and b > 0. */
const halfUp = (a: bigint, b: bigint) => (2n * a + b) / (2n * b);
/** ceil(a / b) for a ≥ 0 and b > 0. */
const up = (a: bigint, b: bigint) => (a + b - 1n) / b;

const SIZES: PackageSize[] = ['SMALL', 'MEDIUM', 'LARGE', 'EXTRA_LARGE'];
const SPEEDS: DeliverySpeed[] = ['STANDARD', 'EXPRESS', 'RUSH'];

/** The parcel's price in hundredths of a dollar × the speed in millionths, for `h` hundredths of a km. */
function parcelScaled(h: number, rates: CourierRates, size: PackageSize, speed: DeliverySpeed): bigint {
  return (B(rates.baseFee) * 100n + B(h) * B(rates.perKmRate) + B(rates.sizeSurcharge[size]) * 100n) * millionths(rates.speedMultiplier[speed]);
}
/** The published parcel fee: to the nearest dollar, a half up. */
const publishedParcelFee = (h: number, rates: CourierRates, size: PackageSize, speed: DeliverySpeed) =>
  Number(halfUp(parcelScaled(h, rates, size, speed), 100n * 1_000_000n));

/** The published taxi fare for `h` hundredths of a km and whole minutes: to the nearest 100, a half up, ≥ the minimum. */
function publishedTaxiFare(rates: TaxiRates, h: number, minutes: number): number {
  const over = B(Math.max(0, h - Math.round((rates.includedKm ?? 0) * 100))); // hundredths of a km past the included distance
  const hundredthsOfDollar = B(rates.base) * 100n + over * B(rates.perKm) + B(rates.perMin) * B(minutes) * 100n;
  return Math.max(rates.minimum, Number(halfUp(hundredthsOfDollar, 10_000n)) * 100);
}

/** A ride class's published fare: the Economy fare × the multiplier, to the nearest 100, ≥ the scaled minimum. */
function publishedClassFare(baseFare: number, multiplier: number, baseMinimum: number): number {
  if (multiplier === 1) return baseFare;
  const hundred = (fare: number) => Number(halfUp(B(fare) * millionths(multiplier), 100n * 1_000_000n)) * 100;
  return Math.max(hundred(baseMinimum), hundred(baseFare));
}

/** Rates the admin pricing screen accepts (COURIER_RATES: whole-dollar money, EXPRESS/RUSH 0.5–10, STANDARD exactly 1). */
const courierRates = (perKmRate: number, express: number, rush: number, baseFee = 800): CourierRates => ({
  ...DEFAULT_COURIER_RATES, baseFee, perKmRate, speedMultiplier: { STANDARD: 1, EXPRESS: express, RUSH: rush },
});

describe('a parcel fee equals the published price', () => {
  it.each([
    // [km, size, speed, fee] at Georgetown's rates: 800 + 120/km + size, × speed, nearest dollar
    [0, 'SMALL', 'STANDARD', 800], [1, 'SMALL', 'STANDARD', 920], [5, 'SMALL', 'STANDARD', 1400],
    [5, 'MEDIUM', 'STANDARD', 1900], [5, 'SMALL', 'EXPRESS', 2100], [5, 'SMALL', 'RUSH', 2800],
    [3.46, 'SMALL', 'STANDARD', 1215], [8.88, 'SMALL', 'STANDARD', 1866], [8.88, 'LARGE', 'EXPRESS', 4298],
    [12.34, 'EXTRA_LARGE', 'RUSH', 8562], [128.05, 'SMALL', 'STANDARD', 16166],
  ] as [number, PackageSize, DeliverySpeed, number][])('%s km %s %s → %s', (km, size, speed, fee) => {
    expect(estimateCourierFee(km, size, speed).totalFee).toBe(fee);
  });

  it.each([
    // [km, per-km, express, rush, base, size, speed, fee]: a true price ending in exactly .5 rounds UP
    [16.15, 175, 1.5, 2, 800, 'SMALL', 'RUSH', 7253], // (800 + 2,826.25) × 2 = 7,252.5
    [16.58, 150, 1.5, 2, 800, 'SMALL', 'EXPRESS', 4931], // (800 + 2,487) × 1.5 = 4,930.5
    [3, 90, 1.15, 2, 500, 'SMALL', 'EXPRESS', 886], //  (500 + 270) × 1.15 = 885.5
    [5, 90, 1.15, 2, 500, 'MEDIUM', 'EXPRESS', 1668], // (500 + 450 + 500) × 1.15 = 1,667.5
  ] as [number, number, number, number, number, PackageSize, DeliverySpeed, number][])(
    '%s km at %s/km (express ×%s, rush ×%s, base %s) %s %s → %s', (km, perKm, express, rush, base, size, speed, fee) => {
      expect(estimateCourierFee(km, size, speed, courierRates(perKm, express, rush, base)).totalFee).toBe(fee);
    });

  it('every canonical distance 0–150 km, every size and speed, at the Georgetown rates', () => {
    const wrong: string[] = [];
    for (let h = 0; h <= 15_000; h++) {
      const km = canonicalBillableKm(h / 100);
      for (const size of SIZES) for (const speed of SPEEDS) {
        const fee = estimateCourierFee(km, size, speed).totalFee;
        if (fee !== publishedParcelFee(h, DEFAULT_COURIER_RATES, size, speed)) wrong.push(`${km} ${size} ${speed}: ${fee}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('every canonical distance 0–40 km at other rates the pricing screen accepts', () => {
    const wrong: string[] = [];
    for (const perKm of [100, 125, 150, 175, 200, 250]) for (const [express, rush] of [[1.5, 2], [1.15, 2.5], [1.25, 3], [1.75, 2.25]]) {
      const rates = courierRates(perKm, express!, rush!);
      for (let h = 0; h <= 4_000; h++) for (const speed of SPEEDS) {
        const fee = estimateCourierFee(h / 100, 'MEDIUM', speed, rates).totalFee;
        if (fee !== publishedParcelFee(h, rates, 'MEDIUM', speed)) wrong.push(`${h / 100} km ${perKm}/km ${speed} ×${rates.speedMultiplier[speed]}: ${fee}`);
      }
    }
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it('the distance part shown with the quote is the per-km part to the nearest dollar', () => {
    const wrong: string[] = [];
    for (const perKm of [120, 125, 150, 175]) {
      for (let h = 0; h <= 5_000; h++) {
        const shown = estimateCourierFee(h / 100, 'SMALL', 'STANDARD', courierRates(perKm, 1.5, 2)).distanceFee;
        if (shown !== Number(halfUp(B(h) * B(perKm), 100n))) wrong.push(`${h / 100} km ${perKm}/km: ${shown}`);
      }
    }
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it('a whole dollar, never down as the distance grows', () => {
    for (const speed of SPEEDS) {
      let last = 0;
      for (let h = 0; h <= 10_000; h++) {
        const fee = estimateCourierFee(h / 100, 'SMALL', speed).totalFee;
        expect(Number.isInteger(fee)).toBe(true);
        expect(fee).toBeGreaterThanOrEqual(last);
        last = fee;
      }
    }
  });

  it('markup.calculateCourierFee (rounds up by design) is the exact round-up', () => {
    const wrong: string[] = [];
    const lower = { STANDARD: 'standard', EXPRESS: 'express', RUSH: 'rush' } as const;
    for (let h = 0; h <= 15_000; h++) for (const size of SIZES) for (const speed of SPEEDS) {
      const fee = calculateCourierFee(h / 100, size, lower[speed]);
      if (fee !== Number(up(parcelScaled(h, DEFAULT_COURIER_RATES, size, speed), 100n * 1_000_000n))) wrong.push(`${h / 100} ${size} ${speed}: ${fee}`);
    }
    expect(wrong).toEqual([]);
    expect(calculateCourierFee(128.05, 'SMALL')).toBe(16166); // 800 + 128.05 × 120 = 16,166 exactly (the float said 16,167)
  });
});

describe('a taxi fare equals the published price', () => {
  const AIRPORT: TaxiRates = { ...DEFAULT_TAXI_RATES, perKm: 295 };

  it.each([
    // [rates, km, minutes, fare]
    ['Georgetown', 0.5, 2, 800], ['Georgetown', 3, 8, 800], ['Georgetown', 3.28, 8, 800], ['Georgetown', 3.3, 8, 900],
    ['Georgetown', 5, 12, 1200], ['Georgetown', 9, 22, 1900], ['Georgetown', 10, 24, 2000], ['Georgetown', 13, 32, 2600],
    ['airport', 5, 12, 1400], ['airport', 13, 32, 3800], ['airport', 25.5, 60, 7400],
  ] as [string, number, number, number][])('%s %s km %s min → %s', (which, km, minutes, fare) => {
    expect(formulaFare(which === 'airport' ? AIRPORT : DEFAULT_TAXI_RATES, km, minutes)).toBe(fare);
  });

  it.each([
    // a true fare ending in exactly 50 rounds UP to the next 100
    [{ ...DEFAULT_TAXI_RATES, perKm: 250 }, 129.2, 311, 32400], //  800 + 126.2 × 250 = 32,350
    [{ ...DEFAULT_TAXI_RATES, perKm: 250, includedKm: 4 }, 4.6, 12, 1000], // 800 + 0.6 × 250 = 950
    [{ ...DEFAULT_TAXI_RATES, perKm: 100, includedKm: 0, perMin: 10 }, 128.2, 13, 13800], // 800 + 12,820 + 130 = 13,750
  ] as [TaxiRates, number, number, number][])('%o %s km %s min → %s', (rates, km, minutes, fare) => {
    expect(formulaFare(rates, km, minutes)).toBe(fare);
  });

  it('every canonical distance 0–200 km at the Georgetown and airport rates', () => {
    const wrong: string[] = [];
    for (const rates of [DEFAULT_TAXI_RATES, AIRPORT]) for (let h = 0; h <= 20_000; h++) {
      const km = canonicalBillableKm(h / 100);
      const minutes = Math.ceil((km / 25) * 60);
      const fare = formulaFare(rates, km, minutes);
      if (fare !== publishedTaxiFare(rates, h, minutes)) wrong.push(`${rates.perKm}/km ${km} km: ${fare}`);
    }
    expect(wrong).toEqual([]);
  });

  it('every canonical distance 0–150 km at zone per-km rates and terms the pricing screen accepts', () => {
    const wrong: string[] = [];
    for (const perKm of [100, 150, 200, 250, 300, 350, 400, 500]) for (const includedKm of [0, 2.5, 3, 4]) for (const perMin of [0, 10]) {
      const rates: TaxiRates = { ...DEFAULT_TAXI_RATES, perKm, includedKm, perMin };
      for (let h = 0; h <= 15_000; h++) {
        const minutes = perMin ? 13 : 0;
        const fare = formulaFare(rates, h / 100, minutes);
        if (fare !== publishedTaxiFare(rates, h, minutes)) wrong.push(`${perKm}/km inc ${includedKm} ${perMin}/min ${h / 100} km: ${fare}`);
      }
    }
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it('a ride class is the Economy fare × its multiplier to the nearest 100', () => {
    expect(applyClassMultiplier(5000, 0.57, 800)).toBe(2900); // 2,850 → 2,900
    expect(applyClassMultiplier(1000, 1.35, 800)).toBe(1400); // Comfort: 1,350 → 1,400
    expect(applyClassMultiplier(2000, 1, 800)).toBe(2000);
    const wrong: string[] = [];
    const multipliers = [...Object.values(DEFAULT_CLASS_RATES), ...Array.from({ length: 951 }, (_, k) => (50 + k) / 100)];
    for (const m of multipliers) for (let fare = 800; fare <= 40_000; fare += 100) {
      const got = applyClassMultiplier(fare, m, 800);
      if (got !== publishedClassFare(fare, m, 800)) wrong.push(`${fare} × ${m}: ${got}`);
    }
    expect(wrong.slice(0, 20)).toEqual([]);
  });

  it('markup.calculateTaxiFare (legacy, rounds up) is the exact round-up', () => {
    expect(calculateTaxiFare(16.6, 40, 800, 175, 0, 800)).toBe(3705); // 800 + 16.6 × 175 = 3,705 exactly (the float said 3,706)
    const wrong: string[] = [];
    for (const surge of [1, 1.3, 1.5]) for (const vehicle of [1, 1.35]) for (let h = 0; h <= 10_000; h++) {
      const minutes = Math.ceil((h / 100 / 25) * 60);
      const scaled = (80_000n + B(h) * 175n + B(minutes) * 2_500n) * millionths(surge) * millionths(vehicle);
      const want = Math.max(800, Number(up(scaled, 100n * 1_000_000n * 1_000_000n)));
      const fare = calculateTaxiFare(h / 100, minutes, 800, 175, 25, 800, surge, vehicle);
      if (fare !== want) wrong.push(`${h / 100} km ×${surge} ×${vehicle}: ${fare}`);
    }
    expect(wrong.slice(0, 20)).toEqual([]);
  });
});

describe('packages/utils prices parcels and taxis the same exact way', () => {
  const REPO = join(__dirname, '..', '..', '..', '..');
  function loadPackage(path: string): Record<string, unknown> {
    const js = ts.transpileModule(readFileSync(join(REPO, path), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} as Record<string, unknown> };
    runInNewContext(js, { module, exports: module.exports });
    return module.exports;
  }
  type Utils = {
    calculateCourierFee: (o: { distanceKm: number; packageSize: PackageSize; speed?: 'standard' | 'express' | 'rush' }) => number;
    calculateTaxiFare: (o: { distanceKm: number; durationMin: number }) => number;
  };

  it('every canonical distance 0–150 km', () => {
    const utils = loadPackage('packages/utils/src/pricing.ts') as Utils;
    const wrong: string[] = [];
    const lower = { STANDARD: 'standard', EXPRESS: 'express', RUSH: 'rush' } as const;
    for (let h = 0; h <= 15_000; h++) {
      for (const size of SIZES) for (const speed of SPEEDS) {
        const fee = utils.calculateCourierFee({ distanceKm: h / 100, packageSize: size, speed: lower[speed] });
        if (fee !== Number(up(parcelScaled(h, DEFAULT_COURIER_RATES, size, speed), 100n * 1_000_000n))) wrong.push(`courier ${h / 100} ${size} ${speed}: ${fee}`);
      }
      // The package's taxi helper rounds up to a whole dollar (no rounding to 100): 800 + 175/km past 3 km.
      const fare = utils.calculateTaxiFare({ distanceKm: h / 100, durationMin: 0 });
      if (fare !== Math.max(800, 800 + Number(up(B(Math.max(0, h - 300)) * 175n, 100n)))) wrong.push(`taxi ${h / 100}: ${fare}`);
    }
    expect(wrong.slice(0, 20)).toEqual([]);
  });
});
