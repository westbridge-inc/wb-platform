/**
 * [APP-PREPTIME · owner 14 Nov 2026] The preparation time a store gives when it
 * accepts an order. Restaurants run the Swift APP on a tablet, so the app's
 * Accept asks exactly what the website's does (apps/web NewOrderTakeover.tsx and
 * the order page): 10, 15, 20, 30, 45 or 60 minutes, 20 unless the staff pick
 * another, sent as `estimatedPrepTime` on PUT /vendor/orders/:id/accept. A
 * booking (APPOINTMENT) is never asked and sends none, as on the website.
 * Pure: no React Native imports.
 */

export const PREP_TIME_CHOICES = [10, 15, 20, 30, 45, 60] as const;
export type PrepChoice = (typeof PREP_TIME_CHOICES)[number];
export const DEFAULT_PREP_MINUTES: PrepChoice = 20;

export function isPrepChoice(value: unknown): value is PrepChoice {
  return typeof value === 'number' && (PREP_TIME_CHOICES as readonly number[]).includes(value);
}

/** Whether Accept asks for a preparation time on this order: every order but a booking. An order not read yet is
 *  not asked (it may be a booking); its board copy, which carries the fulfillment, is usually there at once. */
export function asksPrepTime(order: { fulfillment?: string | null } | null | undefined): boolean {
  return !!order && order.fulfillment !== 'APPOINTMENT';
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
