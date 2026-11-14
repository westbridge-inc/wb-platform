import { describe, expect, it, vi } from 'vitest';

vi.mock('./text', () => ({ T: 'T' }));

import { Money } from './money';
import { money } from '../lib/money';

// [MENU-OPTIONS · review S4] A card outside the store (search, market) shows a sized item's price as its smallest size:
// it reads "From $X", like the store's own menu rows. Synthetic amounts only.
const text = (node: { props: { children: unknown } }) => ([] as unknown[]).concat(node.props.children).join('');

describe('[MENU-OPTIONS] Money reads "From" for an item whose size sets its price', () => {
  it('a sized item: "From $1,200"', () => {
    expect(text(Money({ amount: 1200, from: true }) as never)).toBe(`From ${money(1200)}`);
  });
  it('any other price: the amount alone, as before', () => {
    expect(text(Money({ amount: 1200 }) as never)).toBe(money(1200));
  });
  it('search and market cards pass the server\'s flag', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const search = readFileSync(join(__dirname, '../modules/shop/screens/SearchScreen.tsx'), 'utf8');
    const market = readFileSync(join(__dirname, '../modules/shop/screens/MarketScreen.tsx'), 'utf8');
    // [STORE-VAT-EXCLUSIVE] ...and the server's "+ VAT" flag beside it.
    expect(search.match(/<Money amount=\{it\.basePrice\} from=\{it\.pricedFrom === true\} vatAdded=\{it\.vatAddedAtCheckout === true\} \/>/g)).toHaveLength(2);
    expect(market).toMatch(/<Money amount=\{item\.basePrice\} from=\{item\.pricedFrom === true\} vatAdded=\{item\.vatAddedAtCheckout === true\} tone="brand" \/>/);
  });
});
