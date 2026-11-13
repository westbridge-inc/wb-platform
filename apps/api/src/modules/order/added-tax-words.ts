/**
 * [STORE-VAT-EXCLUSIVE · owner 13 Nov 2026] The store screens' words for the VAT a store pricing BEFORE VAT added at
 * checkout (billing/store-money.ts puts this line under the store's food money). Kept out of the billing folder, whose
 * partner FEE surfaces must never print VAT while Westbridge Inc. is not VAT-registered (fee-receipt.test R11): this is
 * the store's own VAT on its own sales, never Swift's fee.
 */
/** [STORE-VAT-EXCLUSIVE] The store's own line for the VAT its order added at checkout (billing/store-money.ts shows it under
 *  the food money): the store's, for the GRA. `amount` is already spelled in the store screens' money words. */
export function storeAddedVatLine(amount: string, rateBps: number | null | undefined): string {
  const rate = rateBps != null ? `${(rateBps / 100).toFixed(2).replace(/\.?0+$/, '')}% ` : '';
  return `Includes VAT ${rate}added at checkout: ${amount} (yours, for the GRA)`;
}
