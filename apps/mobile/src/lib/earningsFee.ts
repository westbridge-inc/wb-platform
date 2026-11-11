// [FOLLOWUPS 11 Nov 2026 · the rider weekly-fee check] What the Earnings screen offers for the weekly fee, decided
// from the SAME server answer the Weekly fee screen reads (GET /{rider,driver}/subscription): its payActions say
// whether a Pay button exists there, and its feeStatus says where the fee stands. Pure, so it is unit-testable.
import { feeStatusOf, liveMmg, type FeeSubscription } from './weeklyFee';
import { liveCard } from './cardFee';

/**
 * - `pay`: the Weekly fee screen has a way to pay now (MMG or card live): the "Pay weekly fee" button.
 * - `cannot-pay-here`: the fee is owed but no way to pay is open in the app: no button that opens a screen with
 *   nothing to pay; a line says so, and `inPerson` says whether paying Swift in person is open (the server's word).
 * - `none`: nothing to pay now (paused, trial, paid ahead, covered...): no button; the fee card above already says
 *   where the fee stands, in the server's words.
 */
export type EarningsFeeDoor = { kind: 'pay' } | { kind: 'cannot-pay-here'; inPerson: boolean } | { kind: 'none' };

/** The fee states in which money is owed now (fee-status.ts). */
const OWED: ReadonlySet<string> = new Set(['DUE', 'SUSPENDED', 'INACTIVE']);

/** `raw`: the subscription read as the server sent it (any shape: a missing or odd answer offers nothing). */
export function earningsFeeDoor(raw: unknown): EarningsFeeDoor {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'none' };
  const sub = raw as FeeSubscription;
  if (liveMmg(sub) || liveCard(sub.payActions)) return { kind: 'pay' };
  if (OWED.has(feeStatusOf(sub).state)) return { kind: 'cannot-pay-here', inPerson: sub.inPerson?.open === true };
  return { kind: 'none' };
}

/** Said in place of the button while the fee is owed and no way to pay is open in the app. */
export const FEE_NOT_PAYABLE_IN_APP = 'Paying the weekly fee in the app is not open right now.';
/** The door to paying Swift in person (the Weekly fee screen asks Swift to arrange it). */
export const FEE_PAY_IN_PERSON_LINK = 'Pay Swift in person';

/** The fee card's promise, in the work the mover does: a rider keeps every delivery fee, a driver every fare. */
export function feeKeepLine(kind: 'RIDER' | 'DRIVER' | null | undefined): string {
  return kind === 'DRIVER'
    ? 'The flat fee is Swift’s only charge — every fare stays yours.'
    : 'The flat fee is Swift’s only charge — every delivery fee stays yours.';
}
