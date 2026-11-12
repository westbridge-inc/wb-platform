import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

import { ItemCard } from './order-ui';

// [MENU-OPTIONS · review S4] A card outside the store (search, market) shows a sized item's price as its smallest size:
// it reads "From $X", like the store page's own rows. Synthetic item only.

describe('[MENU-OPTIONS] cards read "From" for an item whose size sets its price', () => {
  it('a sized item: "From $1,200"; any other item: the price alone', () => {
    const { rerender } = render(<ItemCard href="/x" name="Sample pie" price={1200} imageUrl={null} priceFrom />);
    expect(screen.getByText(/From \$1,200/)).toBeTruthy();
    rerender(<ItemCard href="/x" name="Sample pie" price={1200} imageUrl={null} />);
    expect(screen.queryByText(/From/)).toBeNull();
  });

  it('search and market pass the server\'s flag', () => {
    const search = readFileSync(join(process.cwd(), 'src/app/(app)/order/search/page.tsx'), 'utf8');
    const market = readFileSync(join(process.cwd(), 'src/app/(app)/market/market-screen.tsx'), 'utf8');
    expect(search).toMatch(/priceFrom=\{item\.pricedFrom === true\}/);
    expect(market).toMatch(/\{item\.pricedFrom \? 'From ' : ''\}\{money\(item\.basePrice\)\}/);
  });
});
