/**
 * [ASSISTED SETUP · owner 12 Nov 2026] A paper, a menu item or an item photo a Swift admin added for the store from the
 * admin console, with the store's recorded OK, says so on the store's own Documents and Menu (the phone and the website
 * read these words). The store can replace anything Swift added, as it replaces its own. Never who at Swift.
 */
const GUYANA_DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/Guyana' });

/** "12 Nov 2026", or null for a missing or unreadable date. */
function day(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : GUYANA_DAY.format(at);
}

/** "Added by Swift on 12 Nov 2026 with your OK" (no date known: without "on …"). */
export function addedBySwiftLine(iso: string | null | undefined): string {
  const on = day(iso);
  return on ? `Added by Swift on ${on} with your OK` : 'Added by Swift with your OK';
}

/** The same for an item's photo, while it is still the photo Swift added. */
export function photoAddedBySwiftLine(iso: string | null | undefined): string {
  const on = day(iso);
  return on ? `Photo added by Swift on ${on} with your OK` : 'Photo added by Swift with your OK';
}

/** Under the line: the store may replace it. */
export const ADDED_BY_SWIFT_REPLACE_HINT = 'You can replace it any time.';
