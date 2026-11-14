// [STORE-VAT · owner O-5] The settings VAT card's date words (the GRA link is lib/gra-vat-url.ts; the item class words sit
// beside the Products page).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/** [REVIEW-F #2102 S4] A certificate's effective date as people read it ("1 Jan 2026"): a calendar day (stored as
 *  midnight UTC), read in UTC so it never shifts to the evening before. The same words as the server's notice. */
export function calendarDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// [VAT-DOCS · owner 30 Oct 2026] How a VAT-registered store's typed prices relate to VAT (the same words as the phone).
// [STORE-VAT-EXCLUSIVE · owner 13 Nov 2026] PRICES_EXCLUDE_VAT: prices before VAT, a "VAT 14%" line at checkout.
export type StoreVatMode = 'PRICES_INCLUDE_VAT' | 'ADD_VAT_AT_CHECKOUT' | 'PRICES_EXCLUDE_VAT';
const VAT_MODE_WORDS: Readonly<Record<StoreVatMode, string>> = {
  PRICES_EXCLUDE_VAT: 'My prices are before VAT (VAT is added at checkout)',
  PRICES_INCLUDE_VAT: 'My prices already include VAT',
  ADD_VAT_AT_CHECKOUT: 'My prices do not include VAT',
};
/** The two choices an older server offers. */
export const VAT_MODE_CHOICES: ReadonlyArray<{ value: StoreVatMode; label: string }> = [
  { value: 'PRICES_INCLUDE_VAT', label: VAT_MODE_WORDS.PRICES_INCLUDE_VAT },
  { value: 'ADD_VAT_AT_CHECKOUT', label: VAT_MODE_WORDS.ADD_VAT_AT_CHECKOUT },
];
/** [STORE-VAT-EXCLUSIVE] The choices this server offers now (GET /vendor/vat `modesOffered`), in its order; an older
 *  server's two otherwise. */
export function vatModeChoices(offered: unknown): ReadonlyArray<{ value: StoreVatMode; label: string }> {
  const list = Array.isArray(offered) ? offered.filter((m): m is StoreVatMode => typeof m === 'string' && m in VAT_MODE_WORDS) : [];
  return list.length > 0 ? list.map((value) => ({ value, label: VAT_MODE_WORDS[value] })) : VAT_MODE_CHOICES;
}
/** The words for any choice (a store's own, even one no longer offered). */
export function vatModeLabel(mode: StoreVatMode | null | undefined): string | null {
  return mode && mode in VAT_MODE_WORDS ? VAT_MODE_WORDS[mode] : null;
}
/** VAT Act s.90(2): the customer always sees the full price, VAT included, before ordering. [REVIEW-F #2256 S3-1] Every
 *  item starts standard-rated, so an unmarked zero-rated item costs customers the VAT too: said when the store chooses.
 *  [S4-1] The VAT is the store's: never worded as Swift adding it. */
export function vatModeHelp(mode: StoreVatMode, ratePercent: number): string {
  // [STORE-VAT-EXCLUSIVE] Prices before VAT: as typed on the menu, VAT its own line at checkout.
  if (mode === 'PRICES_EXCLUDE_VAT') {
    return `Once a person at Swift approves your certificate, customers see the prices you type (before VAT), with “+ VAT” beside standard-rated items, and ${ratePercent}% VAT is added at checkout as its own line before the total. Every item counts as standard-rated until you mark it zero-rated or exempt: mark those before a person approves, or customers pay VAT on them.`;
  }
  return mode === 'ADD_VAT_AT_CHECKOUT'
    ? `Once a person at Swift approves your certificate, ${ratePercent}% VAT is added to the price you type for each standard-rated item, so customers see and pay the full price, VAT included, before they order. Every item counts as standard-rated until you mark it zero-rated or exempt: mark those before a person approves, or customers pay VAT on them.`
    : 'Customers pay the prices you type; receipts show the VAT inside them.';
}
/** [STORE-VAT-EXCLUSIVE · REVIEW-B S4-6] A store whose approved prices INCLUDE VAT asking to price before VAT: its typed
 *  prices stay as they are and 14% is added on top, so customers pay 14% more unless it lowers its prices first.
 *  (The same words as the phone, lib/storeVat.ts vatBasisChangeWarning.) */
export function vatBasisChangeWarning(from: StoreVatMode | null | undefined, to: StoreVatMode | null | undefined, ratePercent: number): string | null {
  if (to !== 'PRICES_EXCLUDE_VAT' || from !== 'PRICES_INCLUDE_VAT') return null;
  return `Your prices now include VAT. Before VAT is added at checkout, lower each standard-rated price to its price before VAT (the price ÷ ${(1 + ratePercent / 100).toFixed(2)}), or customers pay ${ratePercent}% more.`;
}
/** [STORE-VAT-EXCLUSIVE · REVIEW-A F5 · REVIEW-B S4-5] While Swift's VAT settings are off: a store whose VAT is still
 *  added at checkout is told so (never "not available" alone), and that turning VAT off stops it. */
export function vatSettingsOffLine(v: { effective?: boolean; vatOnTop?: boolean; ratePercent: number }): string {
  if (v.vatOnTop === true && v.effective === true) {
    return `VAT settings cannot be changed on Swift right now, but your approved VAT is still added at checkout: ${v.ratePercent}% on your standard-rated items. To stop it, turn VAT off.`;
  }
  return 'VAT settings are not available on Swift right now. Your prices stay exactly as you typed them.';
}
/** [VAT-DOCS · owner ruling 31 Oct 2026] An APPROVED store that picks the other choice: a person checks the change first. */
export const MODE_CHANGE_REVIEW_NOTE = 'A person at Swift checks a change of this choice before it applies. Until then your prices and what customers pay stay as they are.';
/** [owner ruling 31 Oct 2026] The change of choice the store is waiting on (GET /vendor/vat `modeRequested`), or null. */
export function modeRequestedLine(requested: StoreVatMode | null | undefined): string | null {
  const label = vatModeLabel(requested);
  if (!label) return null;
  return `You asked to change to “${label}”. A person at Swift will check the change. Until then your prices and what customers pay stay as they are.`;
}
/** [STORE-VAT-EXCLUSIVE] Turning VAT off for a store pricing before VAT: no VAT line at checkout any more. */
export const TURN_OFF_VAT_LINE_LINE = ' VAT stops being added at checkout: customers pay the prices you typed.';
/** Turning VAT off for a store whose VAT is added to its prices: the prices it typed come back. */
export const TURN_OFF_ADDED_PRICES_LINE = ' VAT stops being added to your prices: customers pay the prices you typed.';
/** The optional document the store may add (never required to go live). */
export const VAT_DOCUMENT_ROW = {
  title: 'VAT certificate (only if VAT-registered)',
  body: 'Only if your business is registered for VAT with the GRA. You do not need it to go live.',
} as const;
