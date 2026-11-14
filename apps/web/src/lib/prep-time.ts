/**
 * [APP-PREPTIME ROUND 2 · owner ruling 14 Nov 2026] The preparation time a store
 * gives when it accepts: 10, 15, 20, 30, 45 or 60 minutes. The time pre-selected
 * is the STORE'S OWN declared prep time (Vendor.estimatedPrepTime, which the order
 * carries from checkout) when it is a choice, else the closest choice; staff can
 * pick another. The app uses the same rule (apps/mobile/src/modules/vendor/prepTime.ts).
 */

export const PREP_TIME_CHOICES = [10, 15, 20, 30, 45, 60] as const;
export type PrepChoice = (typeof PREP_TIME_CHOICES)[number];
/** No declared time on the order (none, 0, junk): 30, the Vendor.estimatedPrepTime default the server's clocks assume. */
export const UNDECLARED_PREP_MINUTES: PrepChoice = 30;

/**
 * The choice for the store's own declared prep time: itself when it is a choice, else the closest. Halfway between two
 * (25) takes the LONGER one: a time quoted too short starts the food-age, pickup-overdue and "very late" clocks early.
 */
export function storePrepChoice(declared: unknown): PrepChoice {
  if (typeof declared !== 'number' || !Number.isFinite(declared) || declared <= 0) return UNDECLARED_PREP_MINUTES;
  let best: PrepChoice = PREP_TIME_CHOICES[0];
  // Ascending, and `<=`: a tie moves on to the longer choice.
  for (const choice of PREP_TIME_CHOICES) if (Math.abs(choice - declared) <= Math.abs(best - declared)) best = choice;
  return best;
}
