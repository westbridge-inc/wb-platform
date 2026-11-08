/**
 * Pricing helpers. Customer prices carry NO markup — customers pay the vendor
 * base price; platform revenue is weekly subscriptions only. The fees below are
 * mover earnings, not platform revenue.
 *
 * The default rates repeat the API's (DEFAULT_DELIVERY_RATES,
 * DEFAULT_COURIER_RATES, DEFAULT_TAXI_RATES), the one place they live;
 * apps/api's fares-georgetown-defaults test pins them to it. The API prices
 * every real fare and fee; these helpers do not round the way it does.
 */

/**
 * Delivery fee = base_fee + max(0, distance - included_km) * per_km_rate.
 * Results are rounded up. Surge is applied as a multiplier.
 */
export function calculateDeliveryFee(options: {
  distanceKm: number;
  baseFee?: number;
  perKmRate?: number;
  includedKm?: number;
  surgeMultiplier?: number;
}): number {
  const { distanceKm, baseFee = 800, perKmRate = 175, includedKm = 3, surgeMultiplier = 1.0 } = options;
  const distanceFee = Math.max(0, distanceKm - includedKm) * perKmRate;
  return Math.ceil((baseFee + distanceFee) * surgeMultiplier);
}

/**
 * Courier fee = base + distance * rate + size surcharge, multiplied by speed.
 */
export function calculateCourierFee(options: {
  distanceKm: number;
  packageSize: 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE';
  speed?: 'standard' | 'express' | 'rush';
}): number {
  const { distanceKm, packageSize, speed = 'standard' } = options;
  const baseFee = 800;
  const perKmRate = 120;
  const sizeSurcharge = { SMALL: 0, MEDIUM: 500, LARGE: 1000, EXTRA_LARGE: 2000 }[packageSize];
  const speedMultiplier = { standard: 1.0, express: 1.5, rush: 2.0 }[speed];
  // Exact integer maths and one round-up [FARE-INTEGER] (128.05 km is 16,166; the float said 16,167).
  if (![distanceKm, sizeSurcharge, speedMultiplier].every(Number.isFinite)) return NaN;
  const units = exactCents(baseFee) * 1000n + exactMetres(distanceKm) * exactCents(perKmRate) + exactCents(sizeSurcharge) * 1000n;
  return Number(exactCeil(units * exactMillionths(speedMultiplier), 100_000n * 1_000_000n));
}

/**
 * Taxi fare = base + max(0, distance - includedKm) * perKm + duration * perMin.
 * Minimum fare enforced.
 */
export function calculateTaxiFare(options: {
  distanceKm: number;
  durationMin: number;
  baseFare?: number;
  includedKm?: number;
  perKmRate?: number;
  perMinRate?: number;
  minimumFare?: number;
  surgeMultiplier?: number;
  vehicleMultiplier?: number;
}): number {
  const {
    distanceKm,
    durationMin,
    baseFare = 800,
    includedKm = 3,
    perKmRate = 175,
    perMinRate = 0,
    minimumFare = 800,
    surgeMultiplier = 1.0,
    vehicleMultiplier = 1.0,
  } = options;
  // Exact integer maths and one round-up [FARE-INTEGER] (8.88 km is 1,829; the float said 1,830).
  const inputs = [distanceKm, durationMin, baseFare, includedKm, perKmRate, perMinRate, minimumFare, surgeMultiplier, vehicleMultiplier];
  if (!inputs.every(Number.isFinite)) return NaN;
  const over = exactMetres(distanceKm) - exactMetres(includedKm);
  // Thousandths of a cent: base, metres past the included distance × cents per km, thousandths of a minute × cents per minute.
  const units = exactCents(baseFare) * 1000n + (over > 0n ? over : 0n) * exactCents(perKmRate)
    + BigInt(Math.round(durationMin * 1000)) * exactCents(perMinRate);
  const surged = units * exactMillionths(surgeMultiplier) * exactMillionths(vehicleMultiplier);
  return Math.max(minimumFare, Number(exactCeil(surged, 100_000n * 1_000_000n * 1_000_000n)));
}

// [FARE-INTEGER] Whole metres, cents and millionths, and an exact ceil(a / b) for b > 0.
const exactMetres = (km: number): bigint => BigInt(Math.round(km * 1000));
const exactCents = (amount: number): bigint => BigInt(Math.round(amount * 100));
const exactMillionths = (multiplier: number): bigint => BigInt(Math.round(multiplier * 1_000_000));
function exactCeil(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a > 0n && q * b !== a ? q + 1n : q;
}
