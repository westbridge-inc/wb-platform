/**
 * Pricing helpers. Customer prices carry NO markup — customers pay the vendor
 * base price; platform revenue is weekly subscriptions only. The fees below
 * (delivery/courier/taxi) are mover earnings, not platform revenue.
 */

import { DEFAULT_COURIER_RATES, type DeliverySpeed } from '../modules/courier/courier.service';

/**
 * Calculate delivery fee based on distance.
 * delivery_fee = base_fee + (distance_km - included_km) * per_km_rate
 * The defaults are DEFAULT_DELIVERY_RATES (below), never numbers of their own.
 *
 * [owner #18, 13 Oct 2026] Never below the base fee, whatever the distance
 * engine (the road route, or the straight-line fallback when routing is down)
 * or the per-market config says: a negative per-km rate or a surge below 1
 * cannot price a delivery under the first-3-km fee the rider is promised.
 */
export function calculateDeliveryFee(
  distanceKm: number,
  baseFee: number = DEFAULT_DELIVERY_RATES.baseFee,
  perKmRate: number = DEFAULT_DELIVERY_RATES.perKmRate,
  includedKm: number = DEFAULT_DELIVERY_RATES.includedKm,
  surgeMultiplier: number = DEFAULT_DELIVERY_RATES.surgeMultiplier,
): number {
  // [DELIVERY-ROUND, 8 Nov 2026] Exact integer maths, then ONE round-up to a
  // whole dollar. In floating point a fee that is exactly whole could land a
  // hair above it and round up a dollar (8.88 km: 800 + 5.88 × 175 = 1,829,
  // but the float said 1829.0000000000002 and charged 1,830). The published
  // price is unchanged: the base, then the per-km rate pro rata past the
  // included distance, times the surge, rounded up to a whole dollar.
  // Distances are whole metres (checkout's canonical km is 0.01 km, so this
  // is exact for every charged fee), money whole cents, surge millionths.
  if (![distanceKm, baseFee, perKmRate, includedKm, surgeMultiplier].every(Number.isFinite)) return NaN;
  const metresOver = BigInt(Math.max(0, Math.round(distanceKm * 1000) - Math.round(includedKm * 1000)));
  const baseCents = BigInt(Math.round(baseFee * 100));
  const rateCentsPerKm = BigInt(Math.round(Math.max(0, perKmRate) * 100));
  const surgeMicro = BigInt(Math.round(surgeMultiplier * 1_000_000));
  // In thousandths of a cent: base × 1,000 + metres × cents-per-km.
  const subtotal = baseCents * 1000n + metresOver * rateCentsPerKm;
  const fee = Number(ceilDiv(subtotal * surgeMicro, 1000n * 100n * 1_000_000n));
  return Math.max(baseFee, fee);
}

/** ceil(a / b) for b > 0, exactly (BigInt division truncates toward zero). */
function ceilDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a > 0n && q * b !== a ? q + 1n : q;
}

/**
 * FUL-003b: the food/grocery delivery-fee schedule, per-country via
 * CountryConfig.deliveryRates — the SAME null→code-default pattern courier
 * (courierRates) and taxi (taxiRates) already use. Delivery was the one
 * remaining vertical whose fee was computed from `calculateDeliveryFee`'s
 * hardcoded parameter defaults instead of config: fine for Georgetown (the
 * defaults ARE its zone) but silently wrong for a second market.
 *
 * The defaults below are the owner's Georgetown schedule. [Owner ruling 8 Nov
 * 2026] A store or food delivery is priced like a taxi: 800 covers the first
 * 3 km, then 175 a kilometre, no surge (it was 500, then 100 a kilometre, from
 * 1 Oct). Express still adds the flat EXPRESS_DELIVERY_SURCHARGE; parcels
 * (DEFAULT_COURIER_RATES) and taxi fares (DEFAULT_TAXI_RATES) are unchanged.
 * They are the ONE place these numbers live: `calculateDeliveryFee`'s
 * parameter defaults read them, a null deliveryRates column prices from them,
 * and the website's Delivery policy states them
 * (delivery-price-800.unit.test.ts holds the two together).
 */
export interface DeliveryRates {
  baseFee: number;
  perKmRate: number;
  includedKm: number;
  surgeMultiplier: number;
}

export const DEFAULT_DELIVERY_RATES: DeliveryRates = {
  baseFee: 800,
  perKmRate: 175,
  includedKm: 3,
  surgeMultiplier: 1.0,
};

/** Tolerant merge of a CountryConfig.deliveryRates JSON over the defaults — a
 *  partial or malformed config can only override what it validly sets (mirrors
 *  mergeCourierRates). */
export function mergeDeliveryRates(raw: unknown): DeliveryRates {
  const cfg = (raw && typeof raw === 'object' ? raw : {}) as Partial<DeliveryRates>;
  return {
    baseFee: typeof cfg.baseFee === 'number' ? cfg.baseFee : DEFAULT_DELIVERY_RATES.baseFee,
    perKmRate: typeof cfg.perKmRate === 'number' ? cfg.perKmRate : DEFAULT_DELIVERY_RATES.perKmRate,
    includedKm: typeof cfg.includedKm === 'number' ? cfg.includedKm : DEFAULT_DELIVERY_RATES.includedKm,
    surgeMultiplier: typeof cfg.surgeMultiplier === 'number' ? cfg.surgeMultiplier : DEFAULT_DELIVERY_RATES.surgeMultiplier,
  };
}

/** Delivery fee from a resolved schedule — the config-driven entry point.
 *  `deliveryFeeFromRates(d, DEFAULT_DELIVERY_RATES)` === `calculateDeliveryFee(d)`
 *  for every distance, so wiring a call site through this preserves behavior. */
export function deliveryFeeFromRates(distanceKm: number, rates: DeliveryRates): number {
  return calculateDeliveryFee(distanceKm, rates.baseFee, rates.perKmRate, rates.includedKm, rates.surgeMultiplier);
}

/** [Owner ruling, 1 Nov 2026] Express (priority) delivery on a store or food
 *  order costs the standard delivery fee PLUS this flat amount, whatever the
 *  distance (before, express was a multiple of the fee). Whole GYD, like
 *  DEFAULT_DELIVERY_RATES. The whole premium is the rider's cash upside: it
 *  rides inside the order's deliveryFee, which createEarnings pays the rider
 *  in full. ONE definition [SWIFT-070]: the cart quote and the checkout charge
 *  both derive the express fee from here (cart-plans planVendorGroup), so the
 *  displayed total can never drift from the total actually charged. Parcels
 *  are not priced here: courier speeds are DEFAULT_COURIER_RATES.speedMultiplier,
 *  unchanged. The website's Delivery policy states this amount
 *  (express-flat-surcharge.unit.test.ts holds the two together). */
export const EXPRESS_DELIVERY_SURCHARGE = 1000;

/** The delivery fee when express/priority is chosen: the standard fee plus the
 *  flat surcharge. Only a DELIVERY plan asks for it — a plan with no rider
 *  (pickup, appointment) carries no premium (cart-plans guards that). */
export function expressDeliveryFee(standardFee: number): number {
  return standardFee + EXPRESS_DELIVERY_SURCHARGE;
}

/**
 * Calculate courier fee based on distance, package size, and speed.
 * The rates are DEFAULT_COURIER_RATES (courier.service), never numbers of
 * their own; this helper keeps its own rounding (up).
 */
export function calculateCourierFee(
  distanceKm: number,
  packageSize: 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE',
  speed: 'standard' | 'express' | 'rush' = 'standard',
): number {
  const { baseFee, perKmRate, sizeSurcharge, speedMultiplier } = DEFAULT_COURIER_RATES;
  const subtotal = baseFee + distanceKm * perKmRate + (sizeSurcharge[packageSize] ?? 0);
  return Math.ceil(subtotal * (speedMultiplier[speed.toUpperCase() as DeliverySpeed] ?? 1.0));
}

/**
 * Calculate a taxi fare from explicit rates. A legacy helper with no
 * production caller and no rates of its own: a rider is quoted formulaFare
 * (rides/fare.service) over the market's TAXI_RATES (country/pricing-config),
 * which also has an included distance and rounds to the nearest 100.
 */
export function calculateTaxiFare(
  distanceKm: number,
  durationMin: number,
  baseFare: number,
  perKmRate: number,
  perMinRate: number,
  minimumFare: number,
  surgeMultiplier: number = 1.0,
  vehicleMultiplier: number = 1.0,
): number {
  const fare = baseFare + distanceKm * perKmRate + durationMin * perMinRate;
  const surgedFare = fare * surgeMultiplier * vehicleMultiplier;
  return Math.max(minimumFare, Math.ceil(surgedFare));
}

// [OWNER RULING 8 Oct: REMOVE THE FARE SLIDER] There is no mover-set price:
// "we go by the thing we set up, base fee plus km". Every delivery fee, courier
// fee and taxi fare is the set formula, booked at checkout and never rewritten
// by an accept. (The driver-set price clamp that lived here is gone.)

const ORDER_SUFFIX_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no 0/O/1/I/L

/**
 * Human-readable order number: SW-YYMMDD-XXX plus a 3-char random suffix.
 * The suffix makes the number collision-proof — two simultaneous checkouts
 * can read the same daily count, and orderNumber is a unique column.
 */
export function generateOrderNumber(sequence: number): string {
  const now = new Date();
  const yy = now.getFullYear().toString().slice(2);
  const mm = (now.getMonth() + 1).toString().padStart(2, '0');
  const dd = now.getDate().toString().padStart(2, '0');
  const seq = sequence.toString().padStart(3, '0');
  let suffix = '';
  for (let i = 0; i < 3; i++) {
    suffix += ORDER_SUFFIX_ALPHABET[Math.floor(Math.random() * ORDER_SUFFIX_ALPHABET.length)];
  }
  return `SW-${yy}${mm}${dd}-${seq}${suffix}`;
}
