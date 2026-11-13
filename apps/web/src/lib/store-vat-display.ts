// [STORE-VAT-EXCLUSIVE · owner 13 Nov 2026] What the website shows customers about a store that prices BEFORE VAT, in ONE
// place (the same words as the phone, lib/storeVat.ts there). The server decides which store and which item carry VAT and
// every amount: the storefront sends `vat` ({ pricesIncludeVat: false, addedAtCheckout: true, ratePercent }), the cart
// quote sends `taxAmount` and `vendors[].vat.added`, a placed order its frozen `taxAmount` / `vatOnTop` / `vatRateBps`.
// The website never computes VAT and never holds a rate; prices are shown exactly as the store typed them.

import { ratePercentWords } from './order-vat-row';

export { orderVatAddedRow, ratePercentWords } from './order-vat-row';

type StorefrontVatRaw = { pricesIncludeVat?: unknown; addedAtCheckout?: unknown; ratePercent?: unknown } | null | undefined;

/** The store page's note for a store pricing before VAT (VAT Act s.90 caution), or null for every other store. */
export function storefrontVatAddedNote(raw: unknown): string | null {
  const v = raw as StorefrontVatRaw;
  if (!v || v.pricesIncludeVat !== false || v.addedAtCheckout !== true || typeof v.ratePercent !== 'number' || !Number.isFinite(v.ratePercent)) return null;
  return `Prices exclude VAT; VAT ${ratePercentWords(v.ratePercent)}% is added at checkout. Zero-rated and exempt items carry none.`;
}

/** "+ VAT" beside a standard-rated price of a store pricing before VAT; nothing otherwise. The price itself never changes. */
export function itemVatAddedHint(raw: unknown, item: { vatClass?: string | null } | null | undefined): string | null {
  if (!storefrontVatAddedNote(raw) || !item) return null;
  return (item.vatClass ?? 'STANDARD') === 'STANDARD' ? '+ VAT' : null;
}

/** The cart's "VAT 14%" rows (the server's amounts, already inside its total), one per store pricing before VAT. */
export function cartVatAddedRows(vendors: ReadonlyArray<{ vendorId: string; name: string; vat?: unknown }> | null | undefined): Array<{ vendorId: string; label: string; amount: number }> {
  const list = vendors ?? [];
  return list.flatMap((s) => {
    const v = s.vat as { added?: unknown; ratePercent?: unknown } | null | undefined;
    if (!v || typeof v.added !== 'number' || !Number.isFinite(v.added) || typeof v.ratePercent !== 'number') return [];
    return [{ vendorId: s.vendorId, label: `${list.length > 1 ? `${s.name} ` : ''}VAT ${ratePercentWords(v.ratePercent)}%`, amount: v.added }];
  });
}
