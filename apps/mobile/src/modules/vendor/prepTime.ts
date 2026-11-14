/**
 * [APP-PREPTIME · owner 14 Nov 2026] The preparation time a store gives when it
 * accepts an order. Restaurants run the Swift APP on a tablet, so the app's
 * Accept asks exactly what the website's does (apps/web NewOrderTakeover.tsx and
 * the order page): 10, 15, 20, 30, 45 or 60 minutes, sent as `estimatedPrepTime`
 * on PUT /vendor/orders/:id/accept. A booking (APPOINTMENT) is never asked and
 * sends none, as on the website.
 * [ROUND 2 · owner ruling 14 Nov 2026] The pre-selected time is the STORE'S OWN
 * declared prep time (Vendor.estimatedPrepTime, which the order carries from
 * checkout: order.service stamps it), or the closest choice; staff can tap
 * another. The website does the same (apps/web lib/prep-time.ts).
 * Pure: no React Native imports.
 */

export const PREP_TIME_CHOICES = [10, 15, 20, 30, 45, 60] as const;
export type PrepChoice = (typeof PREP_TIME_CHOICES)[number];
/** No declared time on the order (none, 0, junk): 30, the Vendor.estimatedPrepTime default that the server's own
 *  clocks also assume (rescue DEFAULT_PREP_PROMISE_MIN, the rating shield's `?? 30`). */
export const UNDECLARED_PREP_MINUTES: PrepChoice = 30;

export function isPrepChoice(value: unknown): value is PrepChoice {
  return typeof value === 'number' && (PREP_TIME_CHOICES as readonly number[]).includes(value);
}

/** Whether Accept asks for a preparation time on this order: every order but a booking. An order not read yet is
 *  not asked (it may be a booking); its board copy, which carries the fulfillment, is usually there at once. */
export function asksPrepTime(order: { fulfillment?: string | null } | null | undefined): boolean {
  return !!order && order.fulfillment !== 'APPOINTMENT';
}

/**
 * The choice that matches the store's own declared prep time: the time itself when it is a choice, else the
 * closest one. Halfway between two (25, between 20 and 30) takes the LONGER one: a time quoted too short starts the
 * food-age, pickup-overdue and "very late" clocks early (REVIEW-A S2-1), a longer one only looks cautious. Under 10
 * is 10, over 60 is 60.
 */
export function storePrepChoice(declared: unknown): PrepChoice {
  if (typeof declared !== 'number' || !Number.isFinite(declared) || declared <= 0) return UNDECLARED_PREP_MINUTES;
  let best: PrepChoice = PREP_TIME_CHOICES[0];
  // Ascending, and `<=`: a tie moves on to the longer choice.
  for (const choice of PREP_TIME_CHOICES) if (Math.abs(choice - declared) <= Math.abs(best - declared)) best = choice;
  return best;
}

/** The minutes an Accept sends for this order: the chosen time, or none for a booking. */
export function acceptPrepMinutes(order: { fulfillment?: string | null } | null | undefined, minutes: unknown): PrepChoice | undefined {
  return asksPrepTime(order) && isPrepChoice(minutes) ? minutes : undefined;
}

/** The heading over the choices: "prep time" is a kitchen's word; any other store gives a ready time. */
export function prepChoiceHeading(vendorType: string | null | undefined): string {
  return vendorType === 'RESTAURANT' ? 'Preparation time' : 'Ready time';
}

/** One choice's words on its button. */
export const prepChipLabel = (minutes: number): string => `${minutes} min`;
