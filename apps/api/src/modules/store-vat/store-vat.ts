/**
 * [STORE-VAT · owner O-5, 22 Oct 2026] A store's VAT: the switch, the ONE predicate that decides whether a store's
 * orders carry VAT, and the certificate's document type.
 *
 * The law (sources in vat-rate.ts; facts table in the lane's VAT-LAW notes, all from the GRA's own material):
 *   - only a business REGISTERED for VAT may charge it (VAT Act s.9-s.11); the Commissioner issues a certificate
 *     stating name, effective date and VAT number (s.12(7)); a false VAT number is an offence (s.67(7)). So a
 *     store-typed number never drives VAT: a PERSON checks the certificate, types the number from it and
 *     confirms the name, and only that approval (store-vat-decisions.ts) makes the store APPROVED;
 *   - a price a registered store advertises must include the VAT and say so (s.90(2)); so VAT is always inside
 *     the price customers see, and Swift never adds VAT on top of a total (a store whose typed prices exclude VAT
 *     has the VAT added INTO each price, vat-pricing.ts);
 *   - only the registered supplier issues a tax invoice, one per supply (s.28(3)-(4), an offence otherwise,
 *     s.67(4)); so Swift's order receipt is never a tax invoice and never says it is one (order/receipt.ts).
 *
 * The VAT is the STORE's: it is inside the price the customer pays the store directly (cash or the store's own
 * MMG). Swift never receives, holds or moves it, and Swift's own fees stay "Not a VAT invoice" (Swift's company is
 * not VAT-registered; billing/fee-receipt.ts is untouched).
 */

import { guyanaDayKey } from '../../utils/guyana-day';

/** The certificate a store sends: a code-level document type (like IDENTITY_DOC_TYPE), outside every store
 *  checklist, so no platform config changes. Reviewed by a person; never auto-approved. */
export const VAT_CERTIFICATE_DOC_TYPE = 'vat_registration_certificate';

export const STORE_VAT_ENV = 'STORE_VAT';

/**
 * The server switch. OFF unless set to exactly '1' (owner 24 Oct: built now, switched on deliberately). OFF: no
 * store can start, send a certificate for, or be approved for VAT, and no new order freezes VAT (orders already
 * placed keep what they froze). ON changes nothing for any store until a person approves its certificate.
 */
export function storeVatEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[STORE_VAT_ENV] === '1';
}

/** The vendor columns every VAT decision reads. */
export const STORE_VAT_SELECT = {
  id: true,
  name: true,
  vatRegistrationNumber: true,
  vatStatus: true,
  vatMode: true,
  // [VAT-DOCS · owner ruling 31 Oct 2026] An approved store's change of price choice, waiting for a person.
  vatModeRequested: true,
  vatCertificateDocId: true,
  vatApprovedNumber: true,
  vatApprovedName: true,
  vatEffectiveFrom: true,
  vatReviewedBy: true,
  vatReviewedAt: true,
  vatReviewNote: true,
} as const;

/** [VAT-DOCS · owner ruling 31 Oct 2026] The stores a person has to look at: a VAT claim waiting, or an approved store's
 *  change of price choice waiting. The admin queue and the dashboard count read this one filter. */
export const STORE_VAT_WAITING_WHERE = {
  OR: [{ vatStatus: 'PENDING' as const }, { vatStatus: 'APPROVED' as const, vatModeRequested: { not: null } }],
};

export interface StoreVatRow {
  vatRegistrationNumber: string | null;
  vatStatus: string;
  vatMode: string | null;
  vatApprovedNumber: string | null;
  vatApprovedName: string | null;
  vatEffectiveFrom?: Date | null;
}

/** [STORE-VAT-EXCLUSIVE · owner 13 Nov 2026] Prices BEFORE VAT: the store's typed prices are shown exactly as typed,
 *  and every order adds the store's VAT on its standard-rated goods as one "VAT 14%" line above the Total. */
export const PRICES_EXCLUDE_VAT = 'PRICES_EXCLUDE_VAT';

export const STORE_VAT_EXCLUSIVE_ENV = 'STORE_VAT_EXCLUSIVE';

/**
 * [STORE-VAT-EXCLUSIVE] The switch for prices before VAT. OFF unless set to exactly '1' (deployed dark). OFF: no store can
 * choose the basis or be approved on it, and every store sees exactly the choices it had before. It never changes what a
 * customer pays: a store a person already approved on this basis keeps adding its VAT at checkout while that approval
 * stands (its typed prices are before VAT, so dropping the VAT would undercharge it); a PERSON moves such a store off
 * the basis (an approved change of choice, or withdrawing its VAT).
 */
export function storeVatExclusiveEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[STORE_VAT_EXCLUSIVE_ENV] === '1';
}

/** Every mode the server honours on an APPROVED store (the predicate): a store approved on a basis keeps it until a
 *  person approves a change, whatever is offered to new claims. */
export const STORE_VAT_MODES_HONOURED: ReadonlySet<string> = new Set(['PRICES_INCLUDE_VAT', 'ADD_VAT_AT_CHECKOUT', PRICES_EXCLUDE_VAT]);

/** The modes a store may choose now, in the order the screens offer them. PRICES_INCLUDE_VAT: its typed prices already
 *  include VAT. [STORE-VAT-EXCLUSIVE · owner 13 Nov 2026] With STORE_VAT_EXCLUSIVE on, a store whose prices exclude VAT
 *  chooses PRICES_EXCLUDE_VAT (listed first: the basis going forward), and ADD_VAT_AT_CHECKOUT (14% added INTO each
 *  price, vat-pricing.ts) is no longer offered to a new choice; stores already on it keep it until a person approves a
 *  change. With the switch off the choices are exactly the earlier two [VAT-DOCS · owner 30 Oct 2026]. */
export function storeVatModesOffered(env: Record<string, string | undefined> = process.env): readonly string[] {
  return storeVatExclusiveEnabled(env) ? [PRICES_EXCLUDE_VAT, 'PRICES_INCLUDE_VAT'] : ['PRICES_INCLUDE_VAT', 'ADD_VAT_AT_CHECKOUT'];
}

export function storeVatModeOffered(mode: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  return mode != null && storeVatModesOffered(env).includes(mode);
}

/**
 * THE predicate: does this store's next order carry VAT? Every reader (checkout, cart quote, storefront) asks
 * this and nothing else. True only while: the switch is on; a person APPROVED the store; a mode the server can
 * honour is chosen; the approval froze a number and a name; the number the store has on its profile is still
 * the one the person approved (a changed number stops VAT at once, before anyone re-checks it); and the
 * certificate's effective date has arrived in Guyana (inEffectOn).
 */
export function storeVatEffective(row: StoreVatRow, env: Record<string, string | undefined> = process.env, now: Date = new Date()): boolean {
  // [STORE-VAT-EXCLUSIVE] A store approved on prices BEFORE VAT keeps its VAT while the approval stands, switch or not:
  // its typed prices exclude VAT, so a switch flip must never take 14% off what its customers pay (storeVatExclusiveEnabled).
  if (!storeVatEnabled(env) && row.vatMode !== PRICES_EXCLUDE_VAT) return false;
  if (row.vatStatus !== 'APPROVED') return false;
  if (!row.vatMode || !STORE_VAT_MODES_HONOURED.has(row.vatMode)) return false;
  if (!row.vatApprovedNumber || !row.vatApprovedName) return false;
  if (row.vatApprovedNumber !== row.vatRegistrationNumber) return false;
  if (row.vatEffectiveFrom && !inEffectOn(row.vatEffectiveFrom, now)) return false;
  return true;
}

/** [STORE-VAT-EXCLUSIVE] Does this store's next order ADD its VAT on top of the goods (a "VAT 14%" line above the
 *  Total)? Exactly while its VAT is in effect on the prices-before-VAT basis. */
export function storeVatOnTop(row: StoreVatRow, env: Record<string, string | undefined> = process.env, now: Date = new Date()): boolean {
  return row.vatMode === PRICES_EXCLUDE_VAT && storeVatEffective(row, env, now);
}

/**
 * [REVIEW-M #2085 S4-1] A certificate's effective date is a GUYANA calendar day (a DATE column, read as its
 * YYYY-MM-DD): it is in effect from 00:00 Guyana time that day, never from 00:00 UTC (20:00 the evening before).
 */
export function inEffectOn(effectiveFrom: Date, now: Date = new Date()): boolean {
  return effectiveFrom.toISOString().slice(0, 10) <= guyanaDayKey(now);
}
