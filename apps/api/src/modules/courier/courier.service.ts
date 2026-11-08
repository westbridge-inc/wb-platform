/**
 * Courier Service — Parcel delivery pricing and lifecycle
 */

import { allFinite, centsOf, divRoundHalfUp, metresOf, millionthsOf } from '../../utils/fare-integer';

export type PackageSize = 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE';
export type DeliverySpeed = 'STANDARD' | 'EXPRESS' | 'RUSH';

/** Courier pricing knobs [UG-CRAFT-03] — per-country via
 *  CountryConfig.courierRates (same null→code-default pattern as taxiRates;
 *  rides were already priced per-country, courier was the one vertical
 *  hardcoded to GYD literals). */
export interface CourierRates {
  baseFee: number;
  perKmRate: number;
  sizeSurcharge: Record<PackageSize, number>;
  speedMultiplier: Record<DeliverySpeed, number>;
}

/** The owner's Georgetown courier rates (1 Oct 2026): 800 plus 120 a
 *  kilometre; the size surcharges and speed multipliers are unchanged. The ONE
 *  place they live — markup.ts's calculateCourierFee reads them too. */
export const DEFAULT_COURIER_RATES: CourierRates = {
  baseFee: 800, // GYD
  perKmRate: 120, // GYD
  sizeSurcharge: { SMALL: 0, MEDIUM: 500, LARGE: 1000, EXTRA_LARGE: 2000 },
  speedMultiplier: { STANDARD: 1.0, EXPRESS: 1.5, RUSH: 2.0 },
};

/** Tolerant merge of a CountryConfig.courierRates JSON over the defaults —
 *  a partial or malformed config can only override what it validly sets. */
export function mergeCourierRates(raw: unknown): CourierRates {
  const cfg = (raw && typeof raw === 'object' ? raw : {}) as Partial<CourierRates>;
  return {
    baseFee: typeof cfg.baseFee === 'number' ? cfg.baseFee : DEFAULT_COURIER_RATES.baseFee,
    perKmRate: typeof cfg.perKmRate === 'number' ? cfg.perKmRate : DEFAULT_COURIER_RATES.perKmRate,
    sizeSurcharge: { ...DEFAULT_COURIER_RATES.sizeSurcharge, ...(cfg.sizeSurcharge ?? {}) },
    speedMultiplier: { ...DEFAULT_COURIER_RATES.speedMultiplier, ...(cfg.speedMultiplier ?? {}) },
  };
}

/** [FARE-INTEGER] The parcel fee in exact integers: (base + km × per-km + size)
 *  × speed, rounded ONCE by `round` (to the nearest dollar for the quote, up
 *  for markup's helper), and the per-km part to the nearest dollar. Inputs are
 *  finite. Units: thousandths of a cent (a whole metre × cents per km). */
export function exactCourierFee(
  distanceKm: number,
  baseFee: number,
  perKmRate: number,
  sizeSurcharge: number,
  speedMultiplier: number,
  round: (a: bigint, b: bigint) => bigint,
): { distanceFee: number; totalFee: number } {
  const distanceUnits = metresOf(distanceKm) * centsOf(perKmRate);
  const subtotalUnits = centsOf(baseFee) * 1000n + distanceUnits + centsOf(sizeSurcharge) * 1000n;
  return {
    distanceFee: Number(divRoundHalfUp(distanceUnits, 100_000n)),
    totalFee: Number(round(subtotalUnits * millionthsOf(speedMultiplier), 100_000n * 1_000_000n)),
  };
}

export interface CourierEstimate {
  baseFee: number;
  distanceFee: number;
  sizeSurcharge: number;
  speedMultiplier: number;
  totalFee: number;
  estimatedMinutes: number;
  currency: 'GYD';
}

export function estimateCourierFee(
  distanceKm: number,
  packageSize: PackageSize,
  speed: DeliverySpeed,
  rates: CourierRates = DEFAULT_COURIER_RATES,
): CourierEstimate {
  const baseFee = rates.baseFee;
  const sizeSurcharge = rates.sizeSurcharge[packageSize];
  const speedMultiplier = rates.speedMultiplier[speed];
  // [FARE-INTEGER, 8 Nov 2026] Exact integer maths, then ONE rounding to the
  // nearest dollar (a half up). In floating point a fee exactly half way could
  // land a hair below it and round a dollar down (per-km 175, RUSH, 16.15 km:
  // (800 + 2,826.25) × 2 = 7,252.5 → 7,253, but the float said 7,252.4999… and
  // charged 7,252). Georgetown's rates never land on such an edge; any rate the
  // pricing screen accepts now prices exactly. The price model is unchanged.
  const { distanceFee, totalFee } = allFinite(distanceKm, baseFee, rates.perKmRate, sizeSurcharge, speedMultiplier)
    ? exactCourierFee(distanceKm, baseFee, rates.perKmRate, sizeSurcharge, speedMultiplier, divRoundHalfUp)
    : { distanceFee: NaN, totalFee: NaN };

  const estimatedMinutes =
    speed === 'RUSH' ? 20 : speed === 'EXPRESS' ? 30 : Math.max(45, distanceKm * 5);

  return {
    baseFee,
    distanceFee,
    sizeSurcharge,
    speedMultiplier,
    totalFee,
    estimatedMinutes: Math.round(estimatedMinutes),
    currency: 'GYD',
  };
}
