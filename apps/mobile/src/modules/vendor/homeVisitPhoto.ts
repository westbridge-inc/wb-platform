/**
 * [OWNER-ASKS · owner ruling 9 Nov 2026] WHO TAKES THE PROFILE PHOTO (the sign-up selfie): riders, drivers, and a
 * service business that goes to the customer. A store owner, store staff and a business that serves customers only at
 * its own place never take one, and the business app never asks them. A business that offers a home visit ("I travel
 * to them" or "Both") is asked inside the app; until it is taken the server refuses home-visit bookings (fail closed)
 * while bookings at the business's own place go on.
 */
export type ServiceVisitMode = 'AT_BUSINESS' | 'MOBILE' | 'BOTH';

/** A listing being edited: ask only when it goes to the customer and there is no photo yet. */
export function homeVisitPhotoNeeded(input: { mode: ServiceVisitMode | null | undefined; hasPhoto: boolean }): boolean {
  return (input.mode === 'MOBILE' || input.mode === 'BOTH') && !input.hasPhoto;
}

/** From GET /verification/status (SERVICE): a home-visit listing exists and the server says the photo is missing. An
 *  older server sends no `photo`: the account's own photo decides. */
export function homeVisitPhotoNeededFromStatus(
  status: { homeVisits?: { offered?: boolean; cleared?: boolean; photo?: boolean } } | null | undefined,
  hasPhoto: boolean,
): boolean {
  const visits = status?.homeVisits;
  if (!visits?.offered) return false;
  return !(typeof visits.photo === 'boolean' ? visits.photo : hasPhoto);
}

export const HOME_VISIT_PHOTO_WORDS = {
  title: 'Home visits need your profile photo',
  body: 'Customers see your profile photo, so they know who is coming to their door. Until you take it, customers cannot book a home visit from you. Bookings at your place are not affected.',
  action: 'Take your photo',
} as const;
