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
 * Exact integer maths (whole metres, cents, surge millionths) and one round-up,
 * like the API's calculateDeliveryFee: in floating point a whole fee could land
 * a hair above itself and round up a dollar (8.88 km gave 1,830, not 1,829).
 */
export function calculateDeliveryFee(options: {
  distanceKm: number;
  baseFee?: number;
  perKmRate?: number;
  includedKm?: number;
  surgeMultiplier?: number;
}): number {
  const { distanceKm, baseFee = 800, perKmRate = 175, includedKm = 3, surgeMultiplier = 1.0 } = options;
  if (![distanceKm, baseFee, perKmRate, includedKm, surgeMultiplier].every(Number.isFinite)) return NaN;
  const metresOver = BigInt(Math.max(0, Math.round(distanceKm * 1000) - Math.round(includedKm * 1000)));
  // In thousandths of a cent, then times the surge in millionths.
  const scaled = (BigInt(Math.round(baseFee * 100)) * 1000n + metresOver * BigInt(Math.round(perKmRate * 100)))
    * BigInt(Math.round(surgeMultiplier * 1_000_000));
  const divisor = 1000n * 100n * 1_000_000n;
  const quotient = scaled / divisor;
  return Number(scaled > 0n && quotient * divisor !== scaled ? quotient + 1n : quotient);
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
  return Math.ceil((baseFee + distanceKm * perKmRate + sizeSurcharge) * speedMultiplier);
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
  const fare = baseFare + Math.max(0, distanceKm - includedKm) * perKmRate + durationMin * perMinRate;
  return Math.max(minimumFare, Math.ceil(fare * surgeMultiplier * vehicleMultiplier));
}
