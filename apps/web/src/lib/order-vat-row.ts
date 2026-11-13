// [STORE-VAT-EXCLUSIVE · owner 13 Nov 2026] A placed order's "VAT 14%" row, in a module of its own so the store's
// order screens (perf budget) load only this. The customer helpers in store-vat-display.ts re-export it.

/** The rate as people read it: 14, 12.5 (never "14.00"). */
export function ratePercentWords(rate: number): string {
  return rate.toFixed(2).replace(/\.?0+$/, '');
}

/** A placed order's "VAT 14%" row (label + amount) when its store priced before VAT; null on every other order. */
export function orderVatAddedRow(order: { vatOnTop?: unknown; vatRateBps?: unknown; taxAmount?: unknown; vatAmount?: unknown } | null | undefined): { label: string; amount: number } | null {
  if (!order || order.vatOnTop !== true || order.vatRateBps == null) return null;
  const bps = Number(order.vatRateBps);
  const amount = Number(order.taxAmount ?? order.vatAmount);
  if (!Number.isFinite(bps) || !Number.isFinite(amount)) return null;
  return { label: `VAT ${ratePercentWords(bps / 100)}%`, amount };
}
