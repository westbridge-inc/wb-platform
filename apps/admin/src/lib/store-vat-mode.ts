// [VAT-DOCS · owner 30 Oct 2026] How a store says its prices relate to VAT, in the reviewer's words: what approving does.
export function vatModeWords(mode: string | null): string {
  // [REVIEW-F #2256 N1] The scope: every item starts standard-rated until the store marks it.
  // [STORE-VAT-EXCLUSIVE · owner 13 Nov 2026] Prices before VAT: the menu stays as typed, VAT is its own line at checkout.
  if (mode === 'PRICES_EXCLUDE_VAT') return 'Prices are before VAT: approving leaves its menu prices as typed and adds a “VAT 14%” line at checkout on its standard-rated goods (every item the store has not marked zero-rated or exempt)';
  if (mode === 'ADD_VAT_AT_CHECKOUT') return 'Prices do not include VAT: approving adds VAT to each standard-rated price customers see (every item the store has not marked zero-rated or exempt)';
  if (mode === 'PRICES_INCLUDE_VAT') return 'Prices already include VAT: approving leaves its prices as they are';
  return 'The store has not said how its prices relate to VAT: it cannot be approved yet';
}

/** [REVIEW-G #2266 S3-1] The approval binds the price choice the reviewer saw: what the approval did, in the same terms. */
export function vatApprovedWords(name: string, mode: string | null): string {
  if (mode === 'PRICES_EXCLUDE_VAT') return `${name}'s VAT is approved. Its menu prices stay as typed; VAT is now added at checkout as its own line.`;
  if (mode === 'ADD_VAT_AT_CHECKOUT') return `${name}'s VAT is approved. VAT is now added to each standard-rated price its customers pay.`;
  return `${name}'s VAT is approved. Its prices already include VAT and stay as they are: customers pay the same.`;
}

/** [VAT-DOCS · owner ruling 31 Oct 2026] An APPROVED store asks to change its price choice: what approving the change does. */
export function vatModeChangeWords(requested: string | null | undefined): string {
  if (requested === 'PRICES_EXCLUDE_VAT') return 'Asks to change to “prices before VAT”: approving puts its menu prices back to what it typed and adds a “VAT 14%” line at checkout on its standard-rated goods.';
  if (requested === 'ADD_VAT_AT_CHECKOUT') return 'Asks to change to “prices do not include VAT”: approving adds VAT to each standard-rated price its customers see (every item it has not marked zero-rated or exempt).';
  if (requested === 'PRICES_INCLUDE_VAT') return 'Asks to change to “prices already include VAT”: approving takes the added VAT off, so customers pay the prices the store typed.';
  return 'Asks to change its price choice to one this page does not know: refuse it and ask the store.';
}
