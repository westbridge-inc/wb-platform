/**
 * [FARE-INTEGER · 8 Nov 2026] Exact integer maths for fares and fees.
 *
 * A price computed in binary floating point and then rounded can land a hair
 * on the wrong side of a rounding edge: a fee that is exactly a whole dollar,
 * or exactly half way, comes out as …0000002 or …4999999 and rounds a dollar
 * (or, to the nearest 100, a hundred) the wrong way. These helpers scale every
 * input to an integer first — distances in whole metres (the canonical billable
 * distance is 0.01 km, so this is exact), money in whole cents, multipliers in
 * millionths — and round ONCE, exactly, with BigInt. The published price rules
 * do not change; only the arithmetic that applies them does.
 */

/** Whole metres in `km` (exact for any distance in 0.001 km steps). */
export const metresOf = (km: number): bigint => BigInt(Math.round(km * 1000));

/** Whole cents in `amount` (exact for whole-dollar rates and fares). */
export const centsOf = (amount: number): bigint => BigInt(Math.round(amount * 100));

/** A multiplier in millionths (exact for up to six decimals: 1.35, 1.5, 2). */
export const millionthsOf = (multiplier: number): bigint => BigInt(Math.round(multiplier * 1_000_000));

/** floor(a / b) for b > 0 (BigInt division truncates toward zero). */
function divFloor(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a < 0n && q * b !== a ? q - 1n : q;
}

/** ceil(a / b) for b > 0, exactly. */
export function divCeil(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a > 0n && q * b !== a ? q + 1n : q;
}

/** a / b to the nearest whole number, a half going up (Math.round's rule), for b > 0, exactly. */
export function divRoundHalfUp(a: bigint, b: bigint): bigint {
  return divFloor(2n * a + b, 2n * b);
}

/** True when every value is a finite number (BigInt() throws on NaN/Infinity, so callers check first). */
export const allFinite = (...values: number[]): boolean => values.every(Number.isFinite);
