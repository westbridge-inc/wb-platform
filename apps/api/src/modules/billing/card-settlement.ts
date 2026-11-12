import { guyanaWallClockParts, startOfGuyanaDay } from '../../utils/guyana-day';

// ---------------------------------------------------------------------------
// [LEGAL-CARDS 12 Nov 2026 · VOID-REFUND-CHECK §3] When a card payment is CERTAINLY settled by the bank.
//
// PowerTranz's written answer to Swift (12 Nov 2026): "VOID if not yet settled by the bank; REFUND once settled"
// (they recommend refunding after settlement). Settlement is done by the acquiring BANK since the September 2026
// migration, "typically 2–3 business days"; there is no PowerTranz end-of-day batch. The bank's cutoff time, time zone
// and calendar are not known yet (asked: VOID-REFUND-CHECK §7). PowerTranz's guide v2.7 says only that a void cancels
// an authorization (sec. 3) and that "partial voids are not supported" (sec. 5.2, 7.6).
//
// Until the bank answers, Swift uses a CONSERVATIVE time rule:
//   - a sale is "certainly settled" from the start of the Guyana day after the 4th business day following the day
//     of the sale (Guyana time; the day of the sale is not counted). 4 is above the bank's typical 2–3, and a sale
//     made after the bank's (unknown) cutoff is still inside it;
//   - a business day is Monday to Friday, not a Guyana public holiday (below). A holiday wrongly left out only makes
//     the date fall EARLIER, so uncertain moveable holidays are listed generously (an extra day only delays a refund
//     and keeps the void);
//   - before that instant Swift VOIDS (whole only) and never refunds; from it, Swift REFUNDS. A void or refund the
//     provider refuses is never followed automatically by the other: a person checks it with the card provider.
// "Certainly unsettled" cannot be stated without the bank's cutoff, so a void may still be refused as settled (a person
// then checks it and may refund it once).
//
// The sale's own time is not stored on every path: a hosted Pay now's sale is made by its completion, which can only
// be sent within the SpiToken's five minutes of the page being made (SPI_TOKEN_LIFETIME_MS) and while the session is
// live. So the sale is taken to be at the LATEST it could have been: the session's creation plus CARD_SALE_WITHIN_MS.
// A later anchor only makes the sale look younger (a void, the conservative choice).
// ---------------------------------------------------------------------------

/** Business days after the sale's day before Swift treats it as certainly settled (bank: typically 2–3). */
export const SETTLED_CERTAIN_BUSINESS_DAYS = 4;
/** A hosted Pay now's sale is made at most this long after its session is created (page 15 min, SpiToken 5 min, margin). */
export const CARD_SALE_WITHIN_MS = 30 * 60_000;

const DAY_MS = 86_400_000;
const ymd = (utcMidnight: number) => new Date(utcMidnight).toISOString().slice(0, 10);

/** Easter Sunday (Gregorian, anonymous algorithm), as a UTC-midnight day number. */
function easterSunday(year: number): number {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(year, month - 1, day);
}

/** [ASSUMED — confirm with the bank's own calendar] Guyana's moveable public holidays (Phagwah, Eid ul-Adha, Youman
 *  Nabi, Deepavali) set by the religious calendar each year, listed generously (the likely day and its neighbour,
 *  and the Monday after one that falls on a Sunday). */
const MOVEABLE_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2026
  '2026-03-03', '2026-03-04', '2026-05-26', '2026-05-27', '2026-08-25', '2026-08-26', '2026-11-08', '2026-11-09',
  // 2027
  '2027-03-22', '2027-03-23', '2027-05-16', '2027-05-17', '2027-08-14', '2027-08-15', '2027-08-16', '2027-10-28', '2027-10-29',
]);

/** Guyana's public holidays of a year that follow the civil calendar, with the Monday after one that falls on a Sunday
 *  (Saturday ones too for Christmas and Boxing Day, generously). */
function fixedHolidays(year: number): Set<string> {
  const out = new Set<string>();
  const add = (month: number, day: number) => {
    const at = Date.UTC(year, month - 1, day);
    out.add(ymd(at));
    const weekday = new Date(at).getUTCDay();
    if (weekday === 0) out.add(ymd(at + DAY_MS));
    if (weekday === 6 && month === 12) out.add(ymd(at + 2 * DAY_MS));
  };
  add(1, 1); // New Year's Day
  add(2, 23); // Republic Day
  add(5, 1); // Labour Day
  add(5, 5); // Arrival Day
  add(5, 26); // Independence Day
  add(8, 1); // Emancipation Day
  add(12, 25); // Christmas Day
  add(12, 26); // Boxing Day
  const easter = easterSunday(year);
  out.add(ymd(easter - 2 * DAY_MS)); // Good Friday
  out.add(ymd(easter + DAY_MS)); // Easter Monday
  // CARICOM Day: the first Monday of July.
  const july1 = Date.UTC(year, 6, 1);
  out.add(ymd(july1 + (((8 - new Date(july1).getUTCDay()) % 7) * DAY_MS)));
  return out;
}

const holidayCache = new Map<number, Set<string>>();
/** A Guyana public holiday (as listed above). */
export function isGuyanaPublicHoliday(day: string): boolean {
  const year = Number(day.slice(0, 4));
  let fixed = holidayCache.get(year);
  if (!fixed) holidayCache.set(year, (fixed = fixedHolidays(year)));
  return fixed.has(day) || MOVEABLE_HOLIDAYS.has(day);
}

/** Monday to Friday, and not a Guyana public holiday. `day` is YYYY-MM-DD. */
export function isGuyanaBusinessDay(day: string): boolean {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !isGuyanaPublicHoliday(day);
}

/** The instant from which a sale made at `saleAt` is CERTAINLY settled: the start of the Guyana day after the `days`th
 *  business day following the sale's Guyana day (that day not counted). */
export function settledCertainAt(saleAt: Date, days: number = SETTLED_CERTAIN_BUSINESS_DAYS): Date {
  const { year, month, day } = guyanaWallClockParts(saleAt);
  let cursor = Date.UTC(year, month - 1, day);
  for (let left = days; left > 0;) {
    cursor += DAY_MS;
    if (isGuyanaBusinessDay(ymd(cursor))) left -= 1;
  }
  return startOfGuyanaDay(ymd(cursor + DAY_MS));
}

/** The latest instant a hosted Pay now's sale can have been made (see above). */
export function cardSaleLatestAt(session: { createdAt: Date }): Date {
  return new Date(session.createdAt.getTime() + CARD_SALE_WITHIN_MS);
}

export type CardReversalKind = 'VOID' | 'REFUND';

/** [VOID-REFUND-CHECK F1/F4] Which reversal fits a sale now: VOID while it may not be settled, REFUND once it certainly is. */
export function reversalKindByAge(session: { createdAt: Date }, now: Date): CardReversalKind {
  return now.getTime() < settledCertainAt(cardSaleLatestAt(session)).getTime() ? 'VOID' : 'REFUND';
}

/** "12 Nov 2026, 00:00 Guyana time": when a sale is certainly settled, in words for a person. */
export function settledCertainWords(session: { createdAt: Date }): string {
  const at = settledCertainAt(cardSaleLatestAt(session));
  const { year, month, day } = guyanaWallClockParts(at);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${day} ${months[month - 1]} ${year}, 00:00 Guyana time`;
}
