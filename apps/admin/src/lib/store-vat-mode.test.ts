import { describe, expect, it } from 'vitest';
import { vatApprovedWords, vatModeChangeWords, vatModeWords } from './store-vat-mode';

// [STORE-VAT-EXCLUSIVE · owner 13 Nov 2026] The reviewer reads what approving a store that prices BEFORE VAT does: its menu
// stays as typed, and a "VAT 14%" line is added at checkout.
describe('the reviewer\'s words for prices before VAT', () => {
  it('the queue row, the approval and a change to it', () => {
    expect(vatModeWords('PRICES_EXCLUDE_VAT')).toContain('approving leaves its menu prices as typed and adds a “VAT 14%” line at checkout');
    expect(vatApprovedWords('Aarna', 'PRICES_EXCLUDE_VAT')).toBe("Aarna's VAT is approved. Its menu prices stay as typed; VAT is now added at checkout as its own line.");
    expect(vatModeChangeWords('PRICES_EXCLUDE_VAT')).toContain('approving puts its menu prices back to what it typed and adds a “VAT 14%” line at checkout');
    // The other choices keep their words.
    expect(vatModeWords('PRICES_INCLUDE_VAT')).toBe('Prices already include VAT: approving leaves its prices as they are');
    expect(vatModeChangeWords('SOMETHING_NEW')).toBe('Asks to change its price choice to one this page does not know: refuse it and ask the store.');
  });
});
